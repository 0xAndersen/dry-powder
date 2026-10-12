import { IS_STATIC_BUILD } from "@/lib/config";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="wide text-2xl font-semibold">This page does not exist</h1>
      <p className="mt-3 text-muted">The address may be mistyped, or the page has moved.</p>
      <a href={IS_STATIC_BUILD ? "./trade/" : "/trade"} className="btn btn-primary mt-6">
        Go to trading
      </a>
    </div>
  );
}
