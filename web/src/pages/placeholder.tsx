import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Routed placeholder for §9.1 views that land in later M4 tasks. Present now so the app
 * shell's navigation is complete and each view can be filled in without touching routing.
 */
export function Placeholder({
  title,
  icon: Icon,
  description,
}: {
  title: string;
  icon: LucideIcon;
  description: string;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Icon className="size-6" />
          </span>
          <p className="max-w-md text-sm text-muted-foreground">{description}</p>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
            Coming in a later M4 task
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
