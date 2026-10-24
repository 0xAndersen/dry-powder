import { redirect } from "next/navigation";
import { IS_STATIC_BUILD } from "@/lib/config";

export default function Home() {
  // The static bundle replaces this page with a relative redirect after export (scripts/postexport.mjs),
  // because an absolute "/trade" would break under a sub-path.
  if (!IS_STATIC_BUILD) redirect("/trade");
  return null;
}
