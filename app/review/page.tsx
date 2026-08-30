import { redirect } from "next/navigation";

/**
 * The approval list has moved into the console.
 *
 * A reviewer picks a report on the board and answers it on that report's case file, where the
 * evidence sits beside the decision. This path stays as a redirect rather than a 404 because
 * it is live on main and other work links to it.
 *
 * The server actions this page used to render are untouched at app/review/actions.ts. They are
 * the approval gate, not the screen, and the case file imports them as they are.
 */
export default async function ReviewPage() {
  redirect("/board");
}
