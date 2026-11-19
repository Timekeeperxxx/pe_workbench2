/**
 * Node-side entry point for the shared A1 locator parser.
 *
 * The implementation lives under `ui/chat/citation-locator.js` because the
 * browser can only fetch statically served `/ui/*` files. Keeping one source
 * of truth means the Node linter/citation builders and the browser linkifier
 * can never disagree about what a locator looks like.
 */

export {
  LOCATOR_SOURCE,
  citationFilenames,
  citationIdentity,
  citationLookup,
  citationQualifiers,
  normalizeLocator,
  locatorKey,
  maskCitationIds,
  extractLocatorMatches,
  resolveLocatorToken,
  default,
} from "../ui/chat/citation-locator.js";
