/** GET /api/analysis — small machine-readable discovery catalog; semantics live in design/plays-analysis.md. */
import { analysisCatalog } from '../../utils/analysis'

export default defineEventHandler(() => analysisCatalog())
