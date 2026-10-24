import { Loader2, Star } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useProfileDefaults, useUpdateProfileDefaults } from "@/api/queries";
import type { ProfileDefaultsRequest, ProfileDefaultsResponse, QualityProfile } from "@/api/types";
import { errorMessage } from "@/api/client";

type MediaScope = "movies" | "shows";

const selectClassName =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:opacity-60";

const SAME_AS_DEFAULT = "";

function appliesTo(profile: QualityProfile, scope: MediaScope) {
  const value = profile.appliesTo ?? "both";
  return value === "both" || value === scope;
}

/** Which server-default badge a profile carries in the list: everything, movies only or series only. */
export function defaultBadge(defaults: ProfileDefaultsResponse | undefined, id: string | null | undefined) {
  if (!defaults || !id) return null;
  const movie = defaults.effective.movie.id === id;
  const series = defaults.effective.series.id === id;
  if (movie && series) return "Default";
  if (movie) return "Movies default";
  if (series) return "Series default";
  return null;
}

export function DefaultBadge({ label }: { label: string }) {
  return (
    <Badge variant="success" className="gap-1 px-1.5 py-0 text-[10px]">
      <Star className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}

/** The server-wide ranking defaults: one profile for everything, optional movie/series overrides, and whether viewers may pick their own. */
export function ProfileDefaultsCard({ profiles }: { profiles: QualityProfile[] }) {
  const { data, isLoading, isError, error } = useProfileDefaults();
  const update = useUpdateProfileDefaults();

  async function save(patch: Partial<ProfileDefaultsRequest>) {
    if (!data) return;
    const body: ProfileDefaultsRequest = {
      defaultProfileId: data.defaultProfileId,
      movieProfileId: data.movieProfileId ?? null,
      seriesProfileId: data.seriesProfileId ?? null,
      viewersMayChoose: data.viewersMayChoose,
      ...patch,
    };
    try {
      await update.mutateAsync(body);
      toast.success("Ranking defaults saved.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (isLoading) return <div className="h-40 w-full animate-pulse rounded-lg bg-muted" aria-label="Loading ranking defaults" />;
  if (isError || !data)
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">{errorMessage(error)}</CardContent>
      </Card>
    );

  const pending = update.isPending;
  const override = (scope: MediaScope, id: "movieProfile" | "seriesProfile", label: string, value: string | null | undefined) => (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={selectClassName}
        value={value ?? SAME_AS_DEFAULT}
        disabled={pending}
        onChange={(e) =>
          void save(
            scope === "movies"
              ? { movieProfileId: e.target.value || null }
              : { seriesProfileId: e.target.value || null },
          )
        }
      >
        <option value={SAME_AS_DEFAULT}>Same as default</option>
        {profiles
          .filter((p) => appliesTo(p, scope))
          .map((p) => (
            <option key={p.id} value={p.id ?? ""}>
              {p.name}
            </option>
          ))}
      </select>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Default ranking profile
          {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Saving" />}
        </CardTitle>
        <CardDescription>
          Ranks versions, recommendations, pre-downloads and new-episode checks for every viewer who follows the
          server, and for Jellyfin and searches without a profile.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="defaultProfile">Default profile</Label>
            <select
              id="defaultProfile"
              className={selectClassName}
              value={data.defaultProfileId ?? "default"}
              disabled={pending}
              onChange={(e) => void save({ defaultProfileId: e.target.value })}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id ?? ""}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {override("movies", "movieProfile", "Movies", data.movieProfileId)}
          {override("shows", "seriesProfile", "Series", data.seriesProfileId)}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="effective-defaults">
          Movies rank with <span className="font-medium text-foreground">{data.effective.movie.name}</span> · series
          rank with <span className="font-medium text-foreground">{data.effective.series.name}</span>. A profile limited
          to one media type never ranks the other; that one falls back to Standard.
        </p>
        <div className="flex items-start justify-between gap-6 rounded-lg border bg-muted/25 p-4">
          <div className="space-y-1">
            <Label htmlFor="viewersMayChoose">Viewers may choose a profile</Label>
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              Viewers pick their own ranking profile in the app (Settings → Ranking profile). Off: everyone ranks with
              the server default; their choices are kept for when you turn it back on.
            </p>
          </div>
          <Switch
            id="viewersMayChoose"
            checked={data.viewersMayChoose}
            disabled={pending}
            onCheckedChange={(checked) => void save({ viewersMayChoose: checked })}
            aria-label="Viewers may choose a profile"
          />
        </div>
      </CardContent>
    </Card>
  );
}
