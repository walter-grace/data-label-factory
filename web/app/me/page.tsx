import { redirect } from "next/navigation";

// /me is a common convention for "my profile"; we use /dashboard as the
// canonical path. Redirect preserves the UX expectation without forking
// the dashboard implementation.
export default function MeRedirect() {
  redirect("/dashboard");
}
