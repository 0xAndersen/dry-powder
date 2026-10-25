import { redirect } from "next/navigation";
import { IS_STATIC_BUILD } from "@/lib/config";

export default function Home() {
  // The static bundle replaces this page with a relative redirect after export (scripts/postexport.mjs), which
  // also honours the mode the visitor chose; an absolute "/simple" would break under a sub-path.
  if (!IS_STATIC_BUILD) redirect("/simple");
  return null;
}
