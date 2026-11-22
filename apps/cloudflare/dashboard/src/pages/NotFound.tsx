import { Compass } from "lucide-react";
import { ButtonLink, EmptyState } from "../components/ui";
import { useDocumentTitle } from "../lib/useDocumentTitle";

export function NotFoundPage() {
  useDocumentTitle("Not found");
  return (
    <div className="card">
      <EmptyState
        icon={<Compass size={20} aria-hidden />}
        title="This page doesn't exist"
        actions={<ButtonLink to="/" variant="primary">Go to overview</ButtonLink>}
      >
        The link may be outdated, or the page was moved.
      </EmptyState>
    </div>
  );
}
