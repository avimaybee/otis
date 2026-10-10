/**
 * @otis/worker/records/read
 * Shared authoritative records reader (R16 Slices B and E): the route, the
 * agent query tool, and dossier refreshes all read through this one owner,
 * so saved edits agree everywhere without duplicated mapping logic.
 */

import { BUILT_IN_RECORDS_LISTS, collectCalculationRefs, evaluateCalculationTree, fieldDisplayType } from '@otis/contracts';
import type {
  CalculationInput,
  CalculationTree,
  ColumnType,
  RecordCell,
  RecordColumn,
  RecordHistoryItem,
  RecordList,
  RecordRow,
  RecordsResponse,
  RecordValue,
} from '@otis/contracts';
import { formatQuoteText } from '@otis/ledger';

/**
 * Resolve one stored cell into a calculation input. Text parses leniently
 * when numeric; anything else is missing, never zero.
 */
function toCalculationInput(value: RecordValue | undefined): CalculationInput {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    const numeric = Number(value);
    return value.trim() !== '' && Number.isFinite(numeric) ? numeric : null;
  }
  if ('amount' in value && 'currency' in value) {
    return { amount: value.amount, currency: String(value.currency) };
  }
  return null;
}

export interface RecordsReadQuery {
  list?: string;
  limit: number;
  cursor?: string;
  search: string;
  sortParam: string;
}
const CORE_BUSINESS_KINDS = new Set([
  'lead',
  'client',
  'prospect',
  'contact',
  'person',
  'business',
  'company',
  'organization',
  'partner',
  'vendor',
  '',
]);

function isCoreBusinessEntity(kind?: string | null): boolean {
  return !kind || CORE_BUSINESS_KINDS.has(kind.toLowerCase());
}

/** Escape LIKE wildcards so search text matches literally. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

const LIKE_ESCAPE = `ESCAPE '\\'`;

/** Opaque keyset cursor: base64url JSON tuple. Invalid cursors restart at the first page. */
function encodeCursor(parts: Array<string | number>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string | undefined, size: number): string[] | null {
  if (!cursor) return null;
  try {
    const padded = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== size || !parsed.every((p) => typeof p === 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}


export async function readRecordsPage(
  db: D1Database,
  workspaceId: string,
  query: RecordsReadQuery,
): Promise<RecordsResponse> {
  const selectedListId = query.list;
  const hasExplicitList = Boolean(selectedListId);
  const limit = query.limit;
  const cursor = query.cursor;
  const search = query.search;

    /**
     * Validated sort spec: `column:direction` against a per-list allowlist.
     * Unknown columns or directions fall back to the list default so a stale
     * client can never inject ordering SQL.
     */
    function parseSort(allowed: Record<string, unknown>, fallback: { column: string; dir: 'asc' | 'desc' }): { column: string; dir: 'asc' | 'desc' } {
      const match = /^([a-z_]+):(asc|desc)$/.exec(query.sortParam);
      const column = match?.[1];
      const dir = match?.[2];
      if (column && dir && Object.prototype.hasOwnProperty.call(allowed, column)) {
        return { column, dir: dir as 'asc' | 'desc' };
      }
      return fallback;
    }

    // 1. Fetch workspace users to resolve assignee IDs to display names
    const usersResult = await db.prepare(
      `SELECT u.id, u.display_name FROM users u JOIN workspace_users wu ON wu.user_id = u.id WHERE wu.workspace_id = ?`,
    )
      .bind(workspaceId)
      .all<{ id: string; display_name: string | null }>();
    const memberMap: Record<string, string> = {};
    for (const u of usersResult.results || []) {
      memberMap[u.id] = u.display_name || 'Teammate';
    }

    // 2. Fetch workspace metadata and durable records definitions
    const [wsRow, listsResult, colsResult, defsResult] = await Promise.all([
      db.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
        .bind(workspaceId)
        .first<{ business_revision: number }>(),
      db.prepare(
        `SELECT id, name, source_kind, status, revision FROM records_lists WHERE workspace_id = ? AND status = 'active' ORDER BY created_at ASC`,
      )
        .bind(workspaceId)
        .all<{ id: string; name: string; source_kind: string; status: string; revision: number }>(),
      db.prepare(
        `SELECT id, list_id, field_id, is_core, core_binding_json, position, visible, width FROM records_list_columns WHERE workspace_id = ? AND visible = 1 ORDER BY position ASC`,
      )
        .bind(workspaceId)
        .all<{
          id: string;
          list_id: string;
          field_id: string | null;
          is_core: number;
          core_binding_json: string | null;
          position: number;
          visible: number;
          width: number | null;
        }>(),
      db.prepare(
        `SELECT id, field_name, display_label, value_type, options_json, calculation_json, updated_at FROM field_defs WHERE workspace_id = ?`,
      )
        .bind(workspaceId)
        .all<{ id: string; field_name: string; display_label: string; value_type: string; options_json: string | null; calculation_json: string | null; updated_at: string }>()
        .catch(() => ({ results: [] as Array<{ id: string; field_name: string; display_label: string; value_type: string; options_json: string | null; calculation_json: string | null; updated_at: string }> })),
    ]);

    const durableLists = listsResult.results || [];
    const durableCols = colsResult.results || [];

    // Workspace field definitions: labels, storage types, and calculation
    // rules for durable custom columns. Keyed by short field name, which is
    // what columns and entity bindings reference.
    const fieldDefById = new Map<string, { name: string; value_type: string; options_json: string | null; calculation_json: string | null; updated_at: string }>();
    for (const d of (defsResult.results || []) as Array<{ id: string; field_name: string; display_label: string; value_type: string; options_json: string | null; calculation_json: string | null; updated_at: string }>) {
      fieldDefById.set(d.field_name, { name: d.display_label, value_type: d.value_type, options_json: d.options_json, calculation_json: d.calculation_json, updated_at: d.updated_at });
    }
    const fieldLabelById = new Map<string, string>();
    for (const [id, def] of fieldDefById) fieldLabelById.set(id, def.name);
    const durableColumnLabel = (fieldId: string | null, columnId: string): string => {
      if (fieldId && fieldLabelById.has(fieldId)) return fieldLabelById.get(fieldId)!;
      return columnId.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
    };
    const durableColumnType = (fieldId: string | null): ColumnType => {
      const def = fieldId ? fieldDefById.get(fieldId) : undefined;
      if (!def) return 'text';
      return fieldDisplayType({ value_type: def.value_type, options_json: def.options_json });
    };

    // Workspaces born after the 0030 migration (or tests seeding identity
    // late) own zero list rows: ensure the built-ins once, idempotently.
    // Archived lists count as present so a deliberate archive is never
    // resurrected by a read. Pre-0030 databases skip silently.
    if (durableLists.length === 0) {
      let totalLists: number | null = null;
      try {
        const counted = await db.prepare(
          `SELECT COUNT(*) AS n FROM records_lists WHERE workspace_id = ?`,
        ).bind(workspaceId).first<{ n: number }>();
        totalLists = counted?.n ?? 0;
      } catch (err) {
        if (!String(err).includes('no such table')) throw err;
      }
      if (totalLists === 0) {
        const nowEnsure = new Date().toISOString();
        await db.batch(
          BUILT_IN_RECORDS_LISTS.map((list) =>
            db.prepare(
              `INSERT OR IGNORE INTO records_lists (workspace_id, id, name, source_kind, status, revision, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
            ).bind(workspaceId, list.id, list.name, list.source_kind, nowEnsure, nowEnsure),
          ),
        );
        const reseeded = await db.prepare(
          `SELECT id, name, source_kind, status, revision FROM records_lists WHERE workspace_id = ? AND status = 'active' ORDER BY created_at ASC`,
        ).bind(workspaceId).all<{ id: string; name: string; source_kind: string; status: string; revision: number }>();
        durableLists.push(...(reseeded.results || []));
      }
    }

    // Group durable columns by list_id
    const durableColsByList = new Map<string, typeof durableCols>();
    for (const col of durableCols) {
      let list = durableColsByList.get(col.list_id);
      if (!list) {
        list = [];
        durableColsByList.set(col.list_id, list);
      }
      list.push(col);
    }

    // 3. Entity Redirects for canonical resolution
    const redirectsResult = await db.prepare(
      'SELECT source_entity_id, target_entity_id FROM entity_redirects WHERE workspace_id = ?',
    )
      .bind(workspaceId)
      .all<{ source_entity_id: string; target_entity_id: string }>();

    const redirects = new Map(
      (redirectsResult.results ?? []).map((r) => [r.source_entity_id, r.target_entity_id]),
    );
    const canonical = (id: string) => {
      for (let depth = 0; depth < 32 && redirects.has(id); depth++) id = redirects.get(id)!;
      return id;
    };

    // 4. Hydrate entities if leads or all lists requested
    const shouldHydrateLeads = !hasExplicitList || selectedListId === 'leads';
    let leadRows: RecordRow[] = [];
    let leadColumns: RecordColumn[] = [];
    let leadsNextCursor: string | null = null;

    // Helper: entity row mapper
    const mapEntityRows = (
      rawEntities: Array<{
        id: string;
        name: string;
        kind: string;
        status: string;
        assigned_user_id: string | null;
        created_at: string;
        updated_at: string;
      }>,
      fieldsByEntity: Map<string, Array<{ field_name: string; value: string; provenance?: string; revision?: number; updated_at?: string }>>,
      contactsByEntity: Map<string, Array<{ id: string; method: string; value: string; is_primary: number; state: string; revision?: number; updated_at?: string }>>,
      openTasksByEntity: Map<string, { title: string; due?: string }>,
      latestNotesByEntity: Map<string, { text: string; date: string; head_event_id: string }>,
      latestQuotesByEntity: Map<string, { quote: string; date: string; head_event_id: string; raw: { amount: number; currency: string; role: string } | null }>,
    ): RecordRow[] => {
      return rawEntities.map((e) => {
        const cells: Record<string, string> = {
          name: e.name,
          status: e.status || 'new',
        };
        const recordCells: Record<string, RecordCell> = {
          name: {
            value: e.name,
            state: 'clear',
            version: e.updated_at,
            binding: { kind: 'entity_property', property: 'name' },
            editable: true,
          },
          status: {
            value: e.status || 'new',
            state: 'clear',
            version: e.updated_at,
            binding: { kind: 'entity_property', property: 'status' },
            editable: true,
          },
        };
        const prov: Record<string, string> = {};

        if (e.assigned_user_id) {
          const assigneeName = memberMap[e.assigned_user_id] ?? 'Teammate';
          cells.assignee = assigneeName;
          recordCells.assignee = {
            value: e.assigned_user_id,
            state: 'clear',
            version: e.updated_at,
            binding: { kind: 'entity_property', property: 'assigned_user_id' },
            editable: true,
          };
        }

        // Phone and email from entity_contacts
        const entContacts = contactsByEntity.get(e.id) || [];
        const phones = entContacts.filter((c) => c.method === 'phone');
        const emails = entContacts.filter((c) => c.method === 'email');

        if (phones.length > 0) {
          const primary = phones.find((c) => c.is_primary && c.state === 'active') || phones.find((c) => c.state === 'active');
          if (primary) {
            cells.phone = primary.value;
            recordCells.phone = {
              value: primary.value,
              state: 'clear',
              version: primary.updated_at || e.updated_at,
              binding: { kind: 'entity_contact', method: 'phone', contact_id: primary.id },
              editable: true,
            };
            prov.phone = 'Contact from business memory';
          } else if (phones.some((c) => c.state === 'disputed')) {
            cells.phone = 'Disputed';
            recordCells.phone = {
              value: 'Disputed',
              state: 'disputed',
              version: e.updated_at,
              binding: { kind: 'entity_contact', method: 'phone' },
              editable: true,
            };
          }
        }

        if (emails.length > 0) {
          const primary = emails.find((c) => c.is_primary && c.state === 'active') || emails.find((c) => c.state === 'active');
          if (primary) {
            cells.email = primary.value;
            recordCells.email = {
              value: primary.value,
              state: 'clear',
              version: primary.updated_at || e.updated_at,
              binding: { kind: 'entity_contact', method: 'email', contact_id: primary.id },
              editable: true,
            };
            prov.email = 'Contact from business memory';
          } else if (emails.some((c) => c.state === 'disputed')) {
            cells.email = 'Disputed';
            recordCells.email = {
              value: 'Disputed',
              state: 'disputed',
              version: e.updated_at,
              binding: { kind: 'entity_contact', method: 'email' },
              editable: true,
            };
          }
        }

        // Entity state fields. Legacy quote/note shadows are stashed: the
        // canonical interaction entry wins display below, and the legacy
        // field only fills in when no interaction exists, with its own
        // distinct entity_field binding.
        const fieldItems = fieldsByEntity.get(e.id) || [];
        let legacyQuoteField: { value: string; version: string; field_name: string } | null = null;
        let legacyNotesField: { value: string; version: string } | null = null;
        for (const item of fieldItems) {
          const key = item.field_name;
          if (key === 'phone' && !cells.phone) {
            cells.phone = item.value;
            recordCells.phone = {
              value: item.value,
              state: 'clear',
              version: item.updated_at || e.updated_at,
              binding: { kind: 'entity_field', field_id: 'phone', field_name: 'phone' },
              editable: true,
            };
          } else if (key === 'email' && !cells.email) {
            cells.email = item.value;
            recordCells.email = {
              value: item.value,
              state: 'clear',
              version: item.updated_at || e.updated_at,
              binding: { kind: 'entity_field', field_id: 'email', field_name: 'email' },
              editable: true,
            };
          } else if (key === 'assigned_user_id') {
            if (!cells.assignee) {
              const val = item.value === 'Disputed' ? 'Disputed' : (memberMap[item.value] ?? '');
              cells.assignee = val;
              recordCells.assignee = {
                value: item.value,
                state: item.value === 'Disputed' ? 'disputed' : 'clear',
                version: item.updated_at || e.updated_at,
                binding: { kind: 'entity_property', property: 'assigned_user_id' },
                editable: true,
              };
            }
          } else if (key === 'preferred_language' || key === 'language') {
            cells.language = item.value;
            recordCells.language = {
              value: item.value,
              state: 'clear',
              version: item.updated_at || e.updated_at,
              binding: { kind: 'entity_field', field_id: key, field_name: key },
              editable: true,
            };
          } else if (key === 'quote' || key === 'deal_value' || key === 'value') {
            if (!legacyQuoteField) {
              legacyQuoteField = { value: item.value, version: item.updated_at || e.updated_at, field_name: key };
            }
          } else if (key === 'access' || key === 'access_instructions') {
            cells.access = item.value;
            recordCells.access = {
              value: item.value,
              state: 'clear',
              version: item.updated_at || e.updated_at,
              binding: { kind: 'entity_field', field_id: key, field_name: key },
              editable: true,
            };
          } else if (key === 'notes' && !cells.notes) {
            if (!legacyNotesField) {
              legacyNotesField = { value: item.value, version: item.updated_at || e.updated_at };
            }
          } else if (key === 'company') {
            cells.company = item.value;
            recordCells.company = {
              value: item.value,
              state: 'clear',
              version: item.updated_at || e.updated_at,
              binding: { kind: 'entity_field', field_id: 'company', field_name: 'company' },
              editable: true,
            };
          } else if (key === 'address') {
            cells.address = item.value;
            recordCells.address = {
              value: item.value,
              state: 'clear',
              version: item.updated_at || e.updated_at,
              binding: { kind: 'entity_field', field_id: 'address', field_name: 'address' },
              editable: true,
            };
          } else if (key !== 'name' && key !== 'status' && key !== 'id' && key !== 'workspace_id') {
            cells[key] = item.value;
            recordCells[key] = {
              value: item.value,
              state: 'clear',
              version: item.updated_at || e.updated_at,
              binding: { kind: 'entity_field', field_id: key, field_name: key },
              editable: true,
            };
          }

          if (item.provenance) {
            prov[key] = item.provenance;
          }
        }

        // Ledger interactions (notes & quotes)
        if (!cells.notes && latestNotesByEntity.has(e.id)) {
          const note = latestNotesByEntity.get(e.id)!;
          cells.notes = note.text;
          recordCells.notes = {
            value: note.text,
            state: 'clear',
            version: note.head_event_id,
            binding: { kind: 'interaction', property: 'latest_note' },
            editable: true,
          };
          prov.notes = `Logged on ${note.date.slice(0, 10)}`;
        }

        if (!cells.value && latestQuotesByEntity.has(e.id)) {
          const quote = latestQuotesByEntity.get(e.id)!;
          cells.value = quote.quote;
          recordCells.value = {
            value: quote.raw ?? quote.quote,
            state: 'clear',
            version: quote.head_event_id,
            binding: { kind: 'interaction', property: 'latest_quote' },
            editable: true,
          };
          prov.value = `Quote from ${quote.date.slice(0, 10)}`;
        }

        // Legacy shadow fallbacks, only when no canonical entry exists.
        if (!cells.value && legacyQuoteField) {
          cells.value = legacyQuoteField.value;
          recordCells.value = {
            value: legacyQuoteField.value,
            state: 'clear',
            version: legacyQuoteField.version,
            binding: { kind: 'entity_field', field_id: legacyQuoteField.field_name, field_name: legacyQuoteField.field_name },
            editable: true,
          };
          prov.value = 'Legacy stored value';
        }
        if (!cells.notes && legacyNotesField) {
          cells.notes = legacyNotesField.value;
          recordCells.notes = {
            value: legacyNotesField.value,
            state: 'clear',
            version: legacyNotesField.version,
            binding: { kind: 'entity_field', field_id: 'notes', field_name: 'notes' },
            editable: true,
          };
          prov.notes = 'Legacy stored note';
        }

        // Open tasks / Next action (earliest effective due date)
        if (openTasksByEntity.has(e.id)) {
          const t = openTasksByEntity.get(e.id)!;
          cells.next_action = t.due ? `${t.title} (${t.due})` : t.title;
          recordCells.next_action = {
            value: t.due ? `${t.title} (${t.due})` : t.title,
            state: 'clear',
            version: e.updated_at,
            binding: { kind: 'task_property', property: 'title' },
            editable: false,
          };
          prov.next_action = 'Open task';
        }

        if (e.kind && e.kind !== 'lead') {
          cells.kind = e.kind.charAt(0).toUpperCase() + e.kind.slice(1);
          recordCells.kind = {
            value: cells.kind,
            state: 'clear',
            version: e.updated_at,
            binding: { kind: 'entity_property', property: 'kind' },
            editable: false,
          };
        }

        return {
          id: e.id,
          ref: { kind: 'entity', id: e.id },
          source: 'entity',
          lifecycle_token: e.updated_at,
          cells,
          record_cells: recordCells,
          ...(Object.keys(prov).length > 0 ? { provenance: prov } : {}),
        };
      });
    };

    const buildColumnsForRows = (rows: RecordRow[], isLeadsList: boolean): RecordColumn[] => {
      const hasData = (colId: string) =>
        rows.some((r) => r.cells[colId] && r.cells[colId].trim().length > 0);

      const cols: RecordColumn[] = [
        {
          id: 'name',
          name: isLeadsList ? 'Lead name' : 'Name',
          type: 'text',
          width: 200,
          is_core: true,
          isCore: true,
          binding: { kind: 'entity_property', property: 'name' },
          capabilities: { sortable: true, filterable: true, editable: true },
        },
        {
          id: 'status',
          name: 'Status',
          type: 'status',
          width: 120,
          is_core: true,
          isCore: true,
          options: ['new', 'warm', 'hot', 'won', 'cold', 'lost', 'deprioritized'],
          binding: { kind: 'entity_property', property: 'status' },
          capabilities: { sortable: true, filterable: true, editable: true },
        },
      ];

      if (isLeadsList) {
        cols.push({
          id: 'phone',
          name: 'Phone',
          type: 'phone',
          width: 160,
          is_core: true,
          isCore: true,
          binding: { kind: 'entity_contact', method: 'phone' },
          capabilities: { sortable: true, filterable: true, editable: true },
        });
        if (hasData('email')) {
          cols.push({
            id: 'email',
            name: 'Email',
            type: 'text',
            width: 180,
            binding: { kind: 'entity_contact', method: 'email' },
            capabilities: { sortable: true, filterable: true, editable: true },
          });
        }
        if (hasData('company')) {
          cols.push({
            id: 'company',
            name: 'Company',
            type: 'text',
            width: 160,
            binding: { kind: 'entity_field', field_id: 'company', field_name: 'company' },
            capabilities: { sortable: true, filterable: true, editable: true },
          });
        }
        if (hasData('value') || rows.length === 0) {
          cols.push({
            id: 'value',
            name: 'Deal value',
            type: 'currency',
            width: 130,
            binding: { kind: 'interaction', property: 'latest_quote' },
            capabilities: { sortable: true, filterable: true, editable: true },
          });
        }
        if (hasData('notes') || rows.length === 0) {
          cols.push({
            id: 'notes',
            name: 'Notes',
            type: 'text',
            width: 280,
            binding: { kind: 'interaction', property: 'latest_note' },
            capabilities: { sortable: true, filterable: true, editable: true },
          });
        }
        if (hasData('next_action')) {
          cols.push({
            id: 'next_action',
            name: 'Next action',
            type: 'text',
            width: 200,
            capabilities: { sortable: true, filterable: true, editable: false },
          });
        }
        if (hasData('assignee')) {
          cols.push({
            id: 'assignee',
            name: 'Assignee',
            type: 'text',
            width: 140,
            binding: { kind: 'entity_property', property: 'assigned_user_id' },
            capabilities: { sortable: true, filterable: true, editable: true },
          });
        }
        if (hasData('kind')) {
          cols.push({
            id: 'kind',
            name: 'Type',
            type: 'text',
            width: 110,
            binding: { kind: 'entity_property', property: 'kind' },
            capabilities: { sortable: true, filterable: true, editable: false },
          });
        }
        if (hasData('address')) {
          cols.push({
            id: 'address',
            name: 'Address',
            type: 'text',
            width: 200,
            binding: { kind: 'entity_field', field_id: 'address', field_name: 'address' },
            capabilities: { sortable: true, filterable: true, editable: true },
          });
        }
        if (hasData('language')) {
          cols.push({
            id: 'language',
            name: 'Language',
            type: 'text',
            width: 120,
            binding: { kind: 'entity_field', field_id: 'preferred_language', field_name: 'preferred_language' },
            capabilities: { sortable: true, filterable: true, editable: true },
          });
        }
        if (hasData('access')) {
          cols.push({
            id: 'access',
            name: 'Access instructions',
            type: 'text',
            width: 240,
            binding: { kind: 'entity_field', field_id: 'access', field_name: 'access' },
            capabilities: { sortable: true, filterable: true, editable: true },
          });
        }
      } else {
        if (hasData('phone')) cols.push({ id: 'phone', name: 'Phone', type: 'phone', width: 160 });
        if (hasData('email')) cols.push({ id: 'email', name: 'Email', type: 'text', width: 180 });
        if (hasData('value')) cols.push({ id: 'value', name: 'Value', type: 'currency', width: 130 });
        if (hasData('notes')) cols.push({ id: 'notes', name: 'Notes', type: 'text', width: 280 });
        if (hasData('assignee')) cols.push({ id: 'assignee', name: 'Assignee', type: 'text', width: 140 });
      }

      // Dynamic custom columns
      const knownIds = new Set(cols.map((c) => c.id));
      for (const row of rows) {
        for (const [cellKey, cellVal] of Object.entries(row.cells)) {
          if (!knownIds.has(cellKey) && cellVal && cellVal.trim().length > 0) {
            knownIds.add(cellKey);
            cols.push({
              id: cellKey,
              name: cellKey.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
              type: /price|cost|amount|val/i.test(cellKey)
                ? 'currency'
                : /^\d+$/.test(cellVal.trim())
                  ? 'number'
                  : 'text',
              width: 160,
              binding: { kind: 'entity_field', field_id: cellKey, field_name: cellKey },
              capabilities: { sortable: true, filterable: true, editable: true },
            });
          }
        }
      }

      const seen = new Set<string>();
      return cols.filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
    };

    // Hydrate leads if needed
    let allRawEntities: Array<{
      id: string;
      name: string;
      kind: string;
      status: string;
      assigned_user_id: string | null;
      created_at: string;
      updated_at: string;
    }> = [];

    if (shouldHydrateLeads || !hasExplicitList) {
      // Keyset on (sort key, id): stable under inserts, no duplicate or
      // omitted rows while paging. The cursor only applies when one list is
      // selected; a combined response always starts at first pages.
      const entitySortMap: Record<string, string> = {
        created: 'created_at', updated: 'updated_at', name: 'name', status: 'status',
      };
      const entitySort = parseSort(entitySortMap, { column: 'created', dir: 'asc' });
      const entitySortCol = entitySortMap[entitySort.column]!;
      const entityDir = entitySort.dir === 'desc' ? 'DESC' : 'ASC';
      const entityCmp = entitySort.dir === 'desc' ? '<' : '>';
      const entityCursor = hasExplicitList && selectedListId === 'leads' ? decodeCursor(cursor, 2) : null;
      let entSql = `SELECT id, name, kind, status, assigned_user_id, created_at, updated_at FROM entities WHERE workspace_id = ? AND status != 'deleted'`;
      const entBinds: unknown[] = [workspaceId];
      if (search) {
        entSql += ` AND (name LIKE ? ${LIKE_ESCAPE} OR id LIKE ? ${LIKE_ESCAPE})`;
        entBinds.push(likePattern(search), likePattern(search));
      }
      if (entityCursor) {
        entSql += ` AND (${entitySortCol} ${entityCmp} ? OR (${entitySortCol} = ? AND id ${entityCmp} ?))`;
        entBinds.push(entityCursor[0], entityCursor[0], entityCursor[1]);
      }
      entSql += ` ORDER BY ${entitySortCol} ${entityDir}, id ${entityDir} LIMIT ?`;
      entBinds.push(limit + 1);

      const entRes = await db.prepare(entSql).bind(...entBinds).all<{
        id: string;
        name: string;
        kind: string;
        status: string;
        assigned_user_id: string | null;
        created_at: string;
        updated_at: string;
      }>();
      allRawEntities = (entRes.results || []).filter((e) => canonical(e.id) === e.id);

      const hasMoreEntities = allRawEntities.length > limit;
      const pageRaw = allRawEntities.slice(0, limit);
      const targetEntities = pageRaw.filter((e) => isCoreBusinessEntity(e.kind));
      const entitySortKeyOf = (row: { created_at: string; updated_at: string; name: string; status: string }): string =>
        entitySort.column === 'updated' ? row.updated_at
          : entitySort.column === 'name' ? row.name
            : entitySort.column === 'status' ? row.status : row.created_at;
      leadsNextCursor = hasMoreEntities && pageRaw.length > 0
        ? encodeCursor([entitySortKeyOf(pageRaw[pageRaw.length - 1]!), pageRaw[pageRaw.length - 1]!.id])
        : null;

      if (targetEntities.length > 0) {
        const entIds = targetEntities.map((e) => e.id);
        const placeholders = entIds.map(() => '?').join(',');

        const batchResults = await db.batch([
          db.prepare(
            `SELECT id, entity_id, method, value, is_primary, state, revision, updated_at
             FROM entity_contacts WHERE workspace_id = ? AND entity_id IN (${placeholders}) AND state != 'removed'
             ORDER BY is_primary DESC, updated_at ASC`,
          ).bind(workspaceId, ...entIds),
          db.prepare(
            `SELECT entity_id, field_name, state, value_text, value_json, provenance, revision, updated_at
             FROM entity_state WHERE workspace_id = ? AND entity_id IN (${placeholders})`,
          ).bind(workspaceId, ...entIds),
          db.prepare(
            `SELECT id, entity_id, title, status, due_kind, due_local_date, due_instant, snooze_until
             FROM tasks WHERE workspace_id = ? AND entity_id IN (${placeholders}) AND status = 'open'
             ORDER BY CASE WHEN due_local_date IS NOT NULL THEN due_local_date WHEN due_instant IS NOT NULL THEN due_instant ELSE '9999-99-99' END ASC`,
          ).bind(workspaceId, ...entIds),
          db.prepare(
            `SELECT i.entity_id, i.kind, i.occurred_at, i.head_event_id, i.head_value_json, e.payload_json AS head_payload_json
             FROM interaction_state i
             LEFT JOIN events e ON e.workspace_id = i.workspace_id AND e.id = i.head_event_id
             WHERE i.workspace_id = ? AND i.entity_id IN (${placeholders}) AND i.state = 'active'
             ORDER BY i.occurred_at DESC`,
          ).bind(workspaceId, ...entIds),
        ]);
        const cRes = batchResults[0];
        const fRes = batchResults[1];
        const tRes = batchResults[2];
        const iRes = batchResults[3];
        if (!cRes || !fRes || !tRes || !iRes) {
          throw new Error('Database batch query returned incomplete results');
        }

        const contactsByEnt = new Map<string, Array<{ id: string; method: string; value: string; is_primary: number; state: string; revision?: number; updated_at?: string }>>();
        for (const c of (cRes.results || []) as Array<{ id: string; entity_id: string; method: string; value: string; is_primary: number; state: string; revision?: number; updated_at?: string }>) {
          const id = canonical(c.entity_id);
          let list = contactsByEnt.get(id);
          if (!list) {
            list = [];
            contactsByEnt.set(id, list);
          }
          list.push(c);
        }

        const fieldsByEnt = new Map<string, Array<{ field_name: string; value: string; provenance?: string; revision?: number; updated_at?: string }>>();
        for (const f of (fRes.results || []) as Array<{ entity_id: string; field_name: string; state: string; value_text: string | null; value_json: string | null; provenance: string; revision?: number; updated_at?: string }>) {
          const id = canonical(f.entity_id);
          let list = fieldsByEnt.get(id);
          if (!list) {
            list = [];
            fieldsByEnt.set(id, list);
          }
          let val = f.state === 'disputed' ? 'Disputed' : (f.value_text ?? '');
          if (!val && f.value_json) {
            try {
              const parsed = JSON.parse(f.value_json);
              val = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
            } catch {
              val = f.value_json;
            }
          }
          list.push({ field_name: f.field_name, value: val, provenance: f.provenance, revision: f.revision, updated_at: f.updated_at });
        }

        const openTasksByEnt = new Map<string, { title: string; due?: string }>();
        for (const t of (tRes.results || []) as Array<{ entity_id: string; title: string; due_local_date: string | null; due_instant: string | null }>) {
          const id = canonical(t.entity_id);
          if (!openTasksByEnt.has(id)) {
            openTasksByEnt.set(id, {
              title: t.title,
              due: t.due_local_date || t.due_instant || undefined,
            });
          }
        }

        const notesByEnt = new Map<string, { text: string; date: string; head_event_id: string }>();
        const quotesByEnt = new Map<string, { quote: string; date: string; head_event_id: string; raw: { amount: number; currency: string; role: string } | null }>();
        for (const inter of (iRes.results || []) as Array<{ entity_id: string; kind: string; occurred_at: string; head_event_id: string; head_value_json: string | null; head_payload_json: string | null }>) {
          const id = canonical(inter.entity_id);
          // Note text lives on the head event payload; only quotes carry a
          // head_value_json snapshot on the lifecycle row.
          const headText = ((): string => {
            const sources = [inter.head_value_json, inter.head_payload_json];
            for (const source of sources) {
              if (!source) continue;
              try {
                const p = JSON.parse(source);
                const text = String(p['text'] || p['summary'] || p['notes'] || '');
                if (text) return text;
              } catch {
                // try the next source
              }
            }
            return '';
          })();
          if (inter.kind === 'note' && !notesByEnt.has(id) && headText) {
            notesByEnt.set(id, { text: headText, date: inter.occurred_at, head_event_id: inter.head_event_id });
          } else if (inter.kind === 'quote' && !quotesByEnt.has(id) && inter.head_value_json) {
            try {
              const p = JSON.parse(inter.head_value_json);
              if (typeof p['amount'] === 'number' && typeof p['currency'] === 'string') {
                const role = p['role'] === 'expected' ? 'expected' : 'offered';
                const formatted = formatQuoteText(p['amount'], p['currency'], role);
                quotesByEnt.set(id, {
                  quote: formatted,
                  date: inter.occurred_at,
                  head_event_id: inter.head_event_id,
                  raw: { amount: p['amount'], currency: p['currency'], role },
                });
              }
            } catch {
              // ignore
            }
          }
        }

        leadRows = mapEntityRows(targetEntities, fieldsByEnt, contactsByEnt, openTasksByEnt, notesByEnt, quotesByEnt);
      }
      leadColumns = buildColumnsForRows(leadRows, true);
    }

    // 5. Tasks list
    const shouldHydrateTasks = !hasExplicitList || selectedListId === 'tasks';
    let taskRows: RecordRow[] = [];
    let tasksNextCursor: string | null = null;
    if (shouldHydrateTasks) {
      const DUE_KEY = `CASE WHEN due_local_date IS NOT NULL THEN due_local_date WHEN due_instant IS NOT NULL THEN due_instant ELSE '9999-99-99' END`;
      const taskSort = parseSort({ due: 'default', title: 'default', created: 'default' }, { column: 'due', dir: 'asc' });
      const taskDir = taskSort.dir === 'desc' ? 'DESC' : 'ASC';
      const taskCmp = taskSort.dir === 'desc' ? '<' : '>';
      const taskKey = taskSort.column === 'title' ? 'title' : taskSort.column === 'created' ? 'created_at' : DUE_KEY;
      const taskCursorSize = taskSort.column === 'due' ? 3 : 2;
      const taskCursor = hasExplicitList && selectedListId === 'tasks' ? decodeCursor(cursor, taskCursorSize) : null;
      let taskSql = `SELECT id, entity_id, title, assignee_user_id, status, due_kind, due_local_date, due_instant, due_timezone, snooze_until, revision, created_at, updated_at FROM tasks WHERE workspace_id = ?`;
      const taskBinds: unknown[] = [workspaceId];
      if (search) {
        taskSql += ` AND (title LIKE ? ${LIKE_ESCAPE})`;
        taskBinds.push(likePattern(search));
      }
      if (taskCursor) {
        if (taskSort.column === 'due') {
          taskSql += ` AND (${DUE_KEY} ${taskCmp} ? OR (${DUE_KEY} = ? AND created_at ${taskCmp} ?) OR (${DUE_KEY} = ? AND created_at = ? AND id ${taskCmp} ?))`;
          taskBinds.push(taskCursor[0], taskCursor[0], taskCursor[1], taskCursor[0], taskCursor[1], taskCursor[2]);
        } else if (taskSort.column === 'title') {
          taskSql += ` AND (title ${taskCmp} ? OR (title = ? AND id ${taskCmp} ?))`;
          taskBinds.push(taskCursor[0], taskCursor[0], taskCursor[1]);
        } else {
          taskSql += ` AND (created_at ${taskCmp} ? OR (created_at = ? AND id ${taskCmp} ?))`;
          taskBinds.push(taskCursor[0], taskCursor[0], taskCursor[1]);
        }
      }
      taskSql += ` ORDER BY ${taskKey} ${taskDir}, ${taskSort.column === 'due' ? 'created_at ' + taskDir + ', ' : ''}id ${taskDir} LIMIT ?`;
      taskBinds.push(limit + 1);

      const taskRes = await db.prepare(taskSql).bind(...taskBinds).all<{
        id: string;
        entity_id: string | null;
        title: string;
        assignee_user_id: string | null;
        status: string;
        due_kind: string | null;
        due_local_date: string | null;
        due_instant: string | null;
        due_timezone: string | null;
        snooze_until: string | null;
        revision: number;
        created_at: string;
        updated_at: string;
      }>();

      const taskPage = (taskRes.results || []).slice(0, limit);
      if ((taskRes.results || []).length > limit && taskPage.length > 0) {
        const last = taskPage[taskPage.length - 1]!;
        tasksNextCursor = taskSort.column === 'due'
          ? encodeCursor([last.due_local_date || last.due_instant || '9999-99-99', last.created_at, last.id])
          : taskSort.column === 'title'
            ? encodeCursor([last.title, last.id])
            : encodeCursor([last.created_at, last.id]);
      }

      taskRows = taskPage.map((t) => {
        const dueVal = t.due_local_date || t.due_instant || (t.snooze_until ? `Snoozed until ${t.snooze_until}` : '');
        const dueStructured: RecordValue = t.due_kind === 'date' && t.due_local_date && t.due_timezone
          ? { kind: 'date', local_date: t.due_local_date, timezone: t.due_timezone }
          : t.due_kind === 'instant' && t.due_instant && t.due_timezone
            ? { kind: 'instant', at: t.due_instant, timezone: t.due_timezone }
            : null;
        const assigneeVal = t.assignee_user_id ? (memberMap[t.assignee_user_id] ?? 'Teammate') : '';
        return {
          id: t.id,
          ref: { kind: 'task', id: t.id },
          source: 'task',
          lifecycle_token: t.updated_at,
          cells: {
            title: t.title,
            status: t.status,
            due: dueVal,
            assignee: assigneeVal,
            entity: t.entity_id || '',
          },
          record_cells: {
            title: { value: t.title, state: 'clear', version: t.updated_at, binding: { kind: 'task_property', property: 'title' }, editable: true },
            status: { value: t.status, state: 'clear', version: t.updated_at, binding: { kind: 'task_property', property: 'status' }, editable: true },
            due: { value: dueStructured, state: 'clear', version: t.updated_at, binding: { kind: 'task_property', property: 'due' }, editable: true },
            assignee: { value: t.assignee_user_id || '', state: 'clear', version: t.updated_at, binding: { kind: 'task_property', property: 'assignee_user_id' }, editable: true },
          },
        };
      });
    }

    const taskColumns: RecordColumn[] = [
      { id: 'title', name: 'Task', type: 'text', width: 260, is_core: true, isCore: true, binding: { kind: 'task_property', property: 'title' }, capabilities: { sortable: true, filterable: true, editable: true } },
      { id: 'status', name: 'Status', type: 'status', width: 120, is_core: true, isCore: true, options: ['open', 'done', 'cancelled'], binding: { kind: 'task_property', property: 'status' }, capabilities: { sortable: true, filterable: true, editable: true } },
      { id: 'due', name: 'Due date', type: 'date', width: 140, binding: { kind: 'task_property', property: 'due' }, capabilities: { sortable: true, filterable: true, editable: true } },
      { id: 'assignee', name: 'Assignee', type: 'text', width: 140, binding: { kind: 'task_property', property: 'assignee_user_id' }, capabilities: { sortable: true, filterable: true, editable: true } },
      { id: 'entity', name: 'Related record', type: 'text', width: 180, capabilities: { sortable: true, filterable: true, editable: false } },
    ];

    // 6. Notes & interactions list
    const shouldHydrateNotes = !hasExplicitList || selectedListId === 'notes';
    let noteRows: RecordRow[] = [];
    let notesNextCursor: string | null = null;
    if (shouldHydrateNotes) {
      const noteSort = parseSort({ occurred: 'default' }, { column: 'occurred', dir: 'desc' });
      const noteDir = noteSort.dir === 'desc' ? 'DESC' : 'ASC';
      const noteCmp = noteSort.dir === 'desc' ? '<' : '>';
      const noteCursor = hasExplicitList && selectedListId === 'notes' ? decodeCursor(cursor, 2) : null;
      let noteSql = `SELECT i.root_event_id, i.head_event_id, i.entity_id, i.kind, i.occurred_at, i.sequence, i.head_value_json, e.actor_kind, e.actor_user_id, e.payload_json
                     FROM interaction_state i
                     JOIN events e ON e.workspace_id = i.workspace_id AND e.id = i.head_event_id
                     WHERE i.workspace_id = ? AND i.state = 'active'`;
      const noteBinds: unknown[] = [workspaceId];
      if (search) {
        noteSql += ` AND (e.payload_json LIKE ? ${LIKE_ESCAPE})`;
        noteBinds.push(likePattern(search));
      }
      if (noteCursor) {
        noteSql += ` AND (i.occurred_at ${noteCmp} ? OR (i.occurred_at = ? AND i.root_event_id ${noteCmp} ?))`;
        noteBinds.push(noteCursor[0], noteCursor[0], noteCursor[1]);
      }
      noteSql += ` ORDER BY i.occurred_at ${noteDir}, i.root_event_id ${noteDir} LIMIT ?`;
      noteBinds.push(limit + 1);

      const noteRes = await db.prepare(noteSql).bind(...noteBinds).all<{
        root_event_id: string;
        head_event_id: string;
        entity_id: string | null;
        kind: string;
        occurred_at: string;
        sequence: number;
        head_value_json: string | null;
        actor_kind: string;
        actor_user_id: string | null;
        payload_json: string;
      }>();

      const notePage = (noteRes.results || []).slice(0, limit);
      if ((noteRes.results || []).length > limit && notePage.length > 0) {
        const lastNote = notePage[notePage.length - 1]!;
        notesNextCursor = encodeCursor([lastNote.occurred_at, lastNote.root_event_id]);
      }

      noteRows = notePage.map((ev) => {
        let summary = '';
        try {
          const p = JSON.parse(ev.head_value_json || ev.payload_json);
          summary = String(p['text'] || p['summary'] || p['notes'] || p['description'] || ev.kind);
          if (ev.kind === 'quote' && typeof p['amount'] === 'number' && typeof p['currency'] === 'string' && typeof p['role'] === 'string') {
            const quote = formatQuoteText(p['amount'], p['currency'], p['role']);
            summary = summary === 'quote' ? quote : `${quote} · ${summary}`;
          }
        } catch {
          summary = ev.kind;
        }

        const actorName = ev.actor_user_id ? (memberMap[ev.actor_user_id] ?? 'Teammate') : (ev.actor_kind === 'system' ? 'Otis' : '');

        return {
          id: ev.root_event_id,
          ref: { kind: 'interaction', id: ev.root_event_id },
          source: 'interaction',
          lifecycle_token: ev.head_event_id,
          cells: {
            date: ev.occurred_at,
            type: ev.kind,
            summary,
            entity: ev.entity_id || '',
            actor: actorName,
          },
          record_cells: {
            date: { value: ev.occurred_at, state: 'clear', version: ev.occurred_at, binding: { kind: 'interaction', property: 'latest_note' }, editable: false },
            type: { value: ev.kind, state: 'clear', version: ev.occurred_at, binding: { kind: 'interaction', property: 'latest_note' }, editable: false },
            summary: { value: summary, state: 'clear', version: ev.head_event_id, binding: { kind: 'interaction', property: 'latest_note' }, editable: true },
            entity: { value: ev.entity_id || '', state: 'clear', version: ev.occurred_at, binding: { kind: 'interaction', property: 'latest_note' }, editable: false },
            actor: { value: actorName, state: 'clear', version: ev.occurred_at, binding: { kind: 'interaction', property: 'latest_note' }, editable: false },
          },
        };
      });
    }

    const noteColumns: RecordColumn[] = [
      { id: 'date', name: 'Date', type: 'text', width: 160, is_core: true, isCore: true, capabilities: { sortable: true, filterable: true, editable: false } },
      { id: 'type', name: 'Type', type: 'text', width: 110, is_core: true, isCore: true, capabilities: { sortable: true, filterable: true, editable: false } },
      { id: 'summary', name: 'Summary / note', type: 'text', width: 340, is_core: true, isCore: true, binding: { kind: 'interaction', property: 'latest_note' }, capabilities: { sortable: true, filterable: true, editable: true } },
      { id: 'entity', name: 'Related record', type: 'text', width: 180, capabilities: { sortable: true, filterable: true, editable: false } },
      { id: 'actor', name: 'Logged by', type: 'text', width: 140, capabilities: { sortable: true, filterable: true, editable: false } },
    ];

    // 7. Drafts list
    const shouldHydrateDrafts = !hasExplicitList || selectedListId === 'drafts';
    let draftRows: RecordRow[] = [];
    let draftsNextCursor: string | null = null;
    if (shouldHydrateDrafts) {
      const draftSort = parseSort({ updated: 'default', title: 'default' }, { column: 'updated', dir: 'desc' });
      const draftDir = draftSort.dir === 'desc' ? 'DESC' : 'ASC';
      const draftCmp = draftSort.dir === 'desc' ? '<' : '>';
      const draftKey = draftSort.column === 'title' ? 'content_text' : 'updated_at';
      const draftCursor = hasExplicitList && selectedListId === 'drafts' ? decodeCursor(cursor, 2) : null;
      let draftSql = `SELECT id, entity_id, channel, recipient_address, content_text, updated_at FROM draft_projections WHERE workspace_id = ? AND status != 'archived'`;
      const draftBinds: unknown[] = [workspaceId];
      if (search) {
        draftSql += ` AND (content_text LIKE ? ${LIKE_ESCAPE})`;
        draftBinds.push(likePattern(search));
      }
      if (draftCursor) {
        draftSql += ` AND (${draftKey} ${draftCmp} ? OR (${draftKey} = ? AND id ${draftCmp} ?))`;
        draftBinds.push(draftCursor[0], draftCursor[0], draftCursor[1]);
      }
      draftSql += ` ORDER BY ${draftKey} ${draftDir}, id ${draftDir} LIMIT ?`;
      draftBinds.push(limit + 1);

      const draftRes = await db.prepare(draftSql).bind(...draftBinds).all<{
        id: string;
        entity_id: string | null;
        channel: string;
        recipient_address: string | null;
        content_text: string;
        updated_at: string;
      }>();

      const draftPage = (draftRes.results || []).slice(0, limit);
      if ((draftRes.results || []).length > limit && draftPage.length > 0) {
        const lastDraft = draftPage[draftPage.length - 1]!;
        draftsNextCursor = encodeCursor([
          draftSort.column === 'title' ? lastDraft.content_text : lastDraft.updated_at,
          lastDraft.id,
        ]);
      }

      draftRows = draftPage.map((d) => ({
        id: d.id,
        ref: { kind: 'draft', id: d.id },
        source: 'draft',
        lifecycle_token: d.updated_at,
        cells: {
          channel: d.channel,
          recipient: d.recipient_address || '',
          content: d.content_text,
          entity: d.entity_id || '',
        },
        record_cells: {
          channel: { value: d.channel, state: 'clear', version: d.updated_at, binding: { kind: 'draft_property', property: 'channel' }, editable: true },
          recipient: { value: d.recipient_address || '', state: 'clear', version: d.updated_at, binding: { kind: 'draft_property', property: 'recipient_address' }, editable: true },
          content: { value: d.content_text, state: 'clear', version: d.updated_at, binding: { kind: 'draft_property', property: 'content_text' }, editable: true },
          entity: { value: d.entity_id || '', state: 'clear', version: d.updated_at, binding: { kind: 'draft_property', property: 'content_text' }, editable: false },
        },
      }));
    }

    const draftColumns: RecordColumn[] = [
      { id: 'channel', name: 'Channel', type: 'text', width: 120, is_core: true, isCore: true, binding: { kind: 'draft_property', property: 'channel' }, capabilities: { sortable: true, filterable: true, editable: true } },
      { id: 'recipient', name: 'Recipient', type: 'text', width: 180, binding: { kind: 'draft_property', property: 'recipient_address' }, capabilities: { sortable: true, filterable: true, editable: true } },
      { id: 'content', name: 'Draft message', type: 'text', width: 360, is_core: true, isCore: true, binding: { kind: 'draft_property', property: 'content_text' }, capabilities: { sortable: true, filterable: true, editable: true } },
      { id: 'entity', name: 'Related record', type: 'text', width: 180, capabilities: { sortable: true, filterable: true, editable: false } },
    ];

    // 8. Custom lists (from records_lists or non-core entity kinds)
    const customLists: RecordList[] = [];
    const handledListIds = new Set(['leads', 'tasks', 'notes', 'drafts']);

    for (const dList of durableLists) {
      if (handledListIds.has(dList.id)) continue;
      handledListIds.add(dList.id);

      const shouldHydrateCustom = !hasExplicitList || selectedListId === dList.id;
      let rows: RecordRow[] = [];
      let customNextCursor: string | null = null;
      const cols: RecordColumn[] = (durableColsByList.get(dList.id) || []).map((c) => {
        const fieldId = c.field_id || c.id;
        const def = c.field_id ? fieldDefById.get(c.field_id) : undefined;
        const columnType = durableColumnType(c.field_id);
        let calculation: RecordColumn['calculation'];
        if (def?.calculation_json) {
          try {
            const parsed = JSON.parse(def.calculation_json) as { description?: string };
            calculation = {
              expression: '',
              description: typeof parsed.description === 'string' ? parsed.description : 'Calculated value',
            };
          } catch {
            calculation = { expression: '', description: 'Calculated value' };
          }
        }
        return {
          id: fieldId,
          name: durableColumnLabel(c.field_id, fieldId),
          type: columnType,
          width: c.width || 160,
          is_core: c.is_core === 1,
          isCore: c.is_core === 1,
          binding: { kind: 'custom_row_value', column_id: fieldId },
          capabilities: { sortable: true, filterable: true, editable: calculation === undefined },
          ...(calculation ? { calculation } : {}),
        };
      });

      if (shouldHydrateCustom && dList.source_kind === 'custom') {
        const customSort = parseSort({ created: 'default' }, { column: 'created', dir: 'asc' });
        const customDir = customSort.dir === 'desc' ? 'DESC' : 'ASC';
        const customCmp = customSort.dir === 'desc' ? '<' : '>';
        const customCursor = hasExplicitList && selectedListId === dList.id ? decodeCursor(cursor, 2) : null;
        let customSql = `SELECT id, created_at, updated_at FROM records_rows WHERE workspace_id = ? AND list_id = ? AND status = 'active'`;
        const customBinds: unknown[] = [workspaceId, dList.id];
        if (customCursor) {
          customSql += ` AND (created_at ${customCmp} ? OR (created_at = ? AND id ${customCmp} ?))`;
          customBinds.push(customCursor[0], customCursor[0], customCursor[1]);
        }
        customSql += ` ORDER BY created_at ${customDir}, id ${customDir} LIMIT ?`;
        customBinds.push(limit + 1);
        const rowRes = await db.prepare(customSql).bind(...customBinds)
          .all<{ id: string; created_at: string; updated_at: string }>();

        const customItems = (rowRes.results || []).slice(0, limit);
        if ((rowRes.results || []).length > limit && customItems.length > 0) {
          const lastCustom = customItems[customItems.length - 1]!;
          customNextCursor = encodeCursor([lastCustom.created_at, lastCustom.id]);
        }
        const customRowItems = customItems;
        if (customRowItems.length > 0) {
          const rowIds = customRowItems.map((r) => r.id);
          const placeholders = rowIds.map(() => '?').join(',');
          const valRes = await db.prepare(
            `SELECT row_id, column_id, value_text, value_json, updated_at FROM records_values WHERE workspace_id = ? AND row_id IN (${placeholders})`,
          ).bind(workspaceId, ...rowIds).all<{ row_id: string; column_id: string; value_text: string | null; value_json: string | null; updated_at: string }>();

          const valuesByRow = new Map<string, Record<string, string>>();
          const recordCellsByRow = new Map<string, Record<string, RecordCell>>();
          for (const v of valRes.results || []) {
            let rowMap = valuesByRow.get(v.row_id);
            if (!rowMap) {
              rowMap = {};
              valuesByRow.set(v.row_id, rowMap);
            }
            let rcMap = recordCellsByRow.get(v.row_id);
            if (!rcMap) {
              rcMap = {};
              recordCellsByRow.set(v.row_id, rcMap);
            }
            const strVal = v.value_text ?? v.value_json ?? '';
            rowMap[v.column_id] = strVal;
            // Structured values stay semantic for editors and calculations;
            // display text rides alongside in the string map.
            let semanticValue: RecordCell['value'] = strVal;
            if (v.value_json) {
              try {
                const parsed: unknown = JSON.parse(v.value_json);
                if (parsed !== null && typeof parsed === 'object') {
                  semanticValue = parsed as RecordCell['value'];
                }
              } catch {
                // Display text already carries the raw content.
              }
            }
            rcMap[v.column_id] = {
              value: semanticValue,
              state: 'clear',
              version: v.updated_at,
              binding: { kind: 'custom_row_value', column_id: v.column_id },
              editable: true,
            };
          }

          rows = customRowItems.map((r) => ({
            id: r.id,
            ref: { kind: 'custom', id: r.id },
            source: 'custom',
            lifecycle_token: r.updated_at,
            cells: valuesByRow.get(r.id) || {},
            record_cells: recordCellsByRow.get(r.id) || {},
          }));

          // Derived calculation columns evaluate on this bounded page with
          // the shared evaluator. Outputs are read-only derived values with
          // their rule description; missing inputs, currency mismatches, and
          // division by zero display as errors instead of zeroes.
          const calcTargets = cols.filter((col) => {
            const def = fieldDefById.get(col.id);
            return !!def?.calculation_json;
          });
          if (calcTargets.length > 0) {
            for (const row of rows) {
              const rcMap = row.record_cells ?? {};
              for (const col of calcTargets) {
                const def = fieldDefById.get(col.id);
                if (!def?.calculation_json) continue;
                let tree: CalculationTree | null = null;
                let description = 'Calculated value';
                try {
                  const parsed = JSON.parse(def.calculation_json) as {
                    expression_tree?: CalculationTree;
                    description?: string;
                  };
                  if (parsed.expression_tree) tree = parsed.expression_tree;
                  if (typeof parsed.description === 'string' && parsed.description) description = parsed.description;
                } catch {
                  tree = null;
                }
                if (!tree) {
                  row.cells[col.id] = 'Calculation is not defined yet. Describe it to Otis.';
                  continue;
                }
                const inputs: Record<string, CalculationInput> = {};
                const refIds = collectCalculationRefs(tree.expression);
                for (const refId of refIds) {
                  inputs[refId] = toCalculationInput(rcMap[refId]?.value);
                }
                const result = evaluateCalculationTree(tree, inputs);
                if (result.ok) {
                  if (result.currency) {
                    const formatted = `${result.currency} ${(result.value / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                    row.cells[col.id] = formatted;
                    rcMap[col.id] = {
                      value: { amount: result.value, currency: result.currency },
                      state: 'clear',
                      version: row.lifecycle_token ?? '',
                      binding: { kind: 'custom_row_value', column_id: col.id },
                      editable: false,
                    };
                  } else {
                    row.cells[col.id] = String(result.value);
                    rcMap[col.id] = {
                      value: result.value,
                      state: 'clear',
                      version: row.lifecycle_token ?? '',
                      binding: { kind: 'custom_row_value', column_id: col.id },
                      editable: false,
                    };
                  }
                  row.provenance = { ...row.provenance, [col.id]: description };
                } else {
                  row.cells[col.id] = result.error;
                  rcMap[col.id] = {
                    value: null,
                    state: 'unknown',
                    version: row.lifecycle_token ?? '',
                    binding: { kind: 'custom_row_value', column_id: col.id },
                    editable: false,
                  };
                  row.provenance = { ...row.provenance, [col.id]: description };
                }
              }
              row.record_cells = rcMap;
            }
          }
        }
      }

      customLists.push({
        id: dList.id,
        name: dList.name,
        source_kind: dList.source_kind as RecordList['source_kind'],
        columns: cols.length > 0 ? cols : [{ id: 'name', name: 'Name', type: 'text', width: 200, is_core: true, isCore: true }],
        rows,
        next_cursor: customNextCursor,
      });
    }

    // Preserve non-core entity kinds from entities table (legacy custom kinds like properties)
    const customKinds = new Set(
      allRawEntities
        .map((e) => e.kind)
        .filter((k): k is string => Boolean(k) && !isCoreBusinessEntity(k) && !handledListIds.has(k)),
    );
    for (const kind of customKinds) {
      handledListIds.add(kind);
      const kindEntities = allRawEntities.filter((e) => e.kind === kind);
      const kindRows = mapEntityRows(kindEntities, new Map(), new Map(), new Map(), new Map(), new Map());
      const kindName = kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      customLists.push({
        id: kind,
        name: kindName,
        source_kind: 'entity',
        description: `Custom ${kindName.toLowerCase()} tracked in business memory.`,
        columns: buildColumnsForRows(kindRows, false),
        rows: kindRows,
      });
    }

    // Honest totals: single cheap counts per built-in list, skipped while
    // searching (a filtered total would need its own count and is reported
    // as unknown instead of a misleading full-list number).
    let totals: Record<string, number> = {};
    if (!search) {
      try {
        const counted = await db.batch([
          db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE workspace_id = ? AND status != 'deleted'`).bind(workspaceId),
          db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?`).bind(workspaceId),
          db.prepare(`SELECT COUNT(*) AS n FROM interaction_state WHERE workspace_id = ? AND state = 'active'`).bind(workspaceId),
          db.prepare(`SELECT COUNT(*) AS n FROM draft_projections WHERE workspace_id = ? AND status != 'archived'`).bind(workspaceId),
        ]);
        const countAt = (index: number): number | null => {
          const row = ((counted[index] as unknown as { results?: Array<{ n: number }> }).results ?? [])[0];
          return row ? Number(row.n) : null;
        };
        const entityTotal = countAt(0);
        const taskTotal = countAt(1);
        const noteTotal = countAt(2);
        const draftTotal = countAt(3);
        totals = {
          ...(entityTotal === null ? {} : { leads: entityTotal }),
          ...(taskTotal === null ? {} : { tasks: taskTotal }),
          ...(noteTotal === null ? {} : { notes: noteTotal }),
          ...(draftTotal === null ? {} : { drafts: draftTotal }),
        };
      } catch (err) {
        if (!String(err).includes('no such table')) throw err;
      }
    }

    const lists: RecordList[] = [
      {
        id: 'leads',
        name: 'Leads',
        source_kind: 'entity',
        description: 'Active client and prospect records tracked by you and Otis.',
        columns: leadColumns,
        rows: leadRows,
        total_rows: totals['leads'],
        next_cursor: leadsNextCursor,
      },
      {
        id: 'tasks',
        name: 'Tasks',
        source_kind: 'task',
        description: 'Action items, commitments and upcoming deadlines.',
        columns: taskColumns,
        rows: taskRows,
        total_rows: totals['tasks'],
        next_cursor: tasksNextCursor,
      },
      {
        id: 'notes',
        name: 'Notes & interactions',
        source_kind: 'interaction',
        description: 'Current notes, calls, visits and quotes captured in conversation.',
        columns: noteColumns,
        rows: noteRows,
        total_rows: totals['notes'],
        next_cursor: notesNextCursor,
      },
      {
        id: 'drafts',
        name: 'Drafts',
        source_kind: 'draft',
        description: 'Prepared outward messages ready for review.',
        columns: draftColumns,
        rows: draftRows,
        total_rows: totals['drafts'],
        next_cursor: draftsNextCursor,
      },
      ...customLists,
    ];

    // 9. History from action receipts, keyed by the list each receipt
    // actually affected. records_batch receipts carry their list in
    // affected_resource_ids; receipts without a list stay under `workspace`
    // instead of masquerading as Leads history.
    const receiptsResult = await db.prepare(
      `SELECT action_id, command_name, result_status, result_json, actor_kind, created_at
       FROM action_receipts WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
      .bind(workspaceId)
      .all<{
        action_id: string;
        command_name: string;
        result_status: string;
        result_json: string;
        actor_kind: string;
        created_at: string;
      }>();

    const historyItems: Record<string, RecordHistoryItem[]> = {};
    for (const r of receiptsResult.results || []) {
      let desc = r.command_name.replace(/_/g, ' ');
      let count = 1;
      let listKey = 'workspace';
      try {
        const parsed = JSON.parse(r.result_json) as {
          summary?: string;
          data?: { affected_count?: number };
          affected_resource_ids?: string[];
        };
        if (parsed.summary) desc = parsed.summary;
        if (typeof parsed.data?.affected_count === 'number') count = parsed.data.affected_count;
        const firstResource = parsed.affected_resource_ids?.[0];
        if (typeof firstResource === 'string' && firstResource) listKey = firstResource;
      } catch {
        // fallback
      }
      const item: RecordHistoryItem = {
        id: r.action_id,
        timestamp: r.created_at,
        actor: r.actor_kind === 'system' ? 'otis' : 'user',
        description: desc,
        affected_count: count,
        affectedCount: count,
        can_restore: r.result_status === 'applied',
        canRestore: r.result_status === 'applied',
      };
      let bucket = historyItems[listKey];
      if (!bucket) {
        bucket = [];
        historyItems[listKey] = bucket;
      }
      bucket.push(item);
    }

    const responsePayload: RecordsResponse = {
      lists,
      history: historyItems,
      selected_list_id: selectedListId,
      revision: wsRow?.business_revision ?? 0,
    };
    return responsePayload;
}
