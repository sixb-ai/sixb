import { join } from "node:path"
import { folderFiles } from "./folder-files"

// The designed proposal for quote Q-881, the RTU-2 repair at Camden Freezer Campus. Its number,
// price, validity, customer and site are fields read from the quote that holds it, and its cases at
// this site a query that starts from that quote: they show what the quote holds, live, until the
// proposal is sent. Its files sit beside this script, in `quote-proposal/`; `demo-artifacts.ts`
// publishes them and attaches the proposal to the quote.

export const quoteProposalTitle = "Q-881: Restore RTU-2 at Camden Freezer Campus"

/** The quote the proposal is for, as the business system names it. */
export const quoteProposalQuoteId = "quote-q-881"

/** Every file of the proposal, at its path inside the artifact. */
export const quoteProposalFiles = () => folderFiles(join(import.meta.dir, "quote-proposal"))
