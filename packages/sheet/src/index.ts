/**
 * @otis/sheet
 * Spreadsheet generator (XLSX in R2) and future Google Sheets sync for Otis.
 */

export interface SheetOptions {
  workspaceId: string;
  workspaceName: string;
  generatedAt: string;
}

export interface GeneratedWorkbook {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}
