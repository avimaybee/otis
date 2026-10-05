// Audit-only entrypoint for the existing synthetic review fixture.
// Its memory router needs the production route '/', not the HTML filename.
// No production source, provider calls, or business records are changed.
import '../../apps/web/node_modules/@fontsource-variable/inter/index.css';
import '../../apps/web/src/globals.css';
import '../../apps/web/src/components/ui/controls.css';
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'short';
history.replaceState(null, '', `/?scenario=${encodeURIComponent(scenario)}`);
void import('../../apps/web/src/review/Review.js');
