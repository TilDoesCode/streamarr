import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The stream-details screen used to be a single long-scrolling page. It now reads as a fixed
 * header/hero (the numbers you always want) plus these sub screens, so drilling into logs,
 * pre-downloads, the article map, network/session identity, or the event history no longer
 * means scrolling past every other section first.
 */
export function StreamDetailTabs({
  defaultTab = "overview",
  overview,
  logs,
  preDownloads,
  articles,
  network,
  events,
}: {
  defaultTab?: string;
  overview: React.ReactNode;
  logs: React.ReactNode;
  preDownloads: React.ReactNode;
  articles: React.ReactNode;
  network: React.ReactNode;
  events: React.ReactNode;
}) {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <Tabs defaultValue={defaultTab}>
        <TabsList className="h-auto max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Performance</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="predownloads">Pre-downloads</TabsTrigger>
          <TabsTrigger value="articles">Articles</TabsTrigger>
          <TabsTrigger value="network">Network & session</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">{overview}</TabsContent>
        <TabsContent value="logs">{logs}</TabsContent>
        <TabsContent value="predownloads">{preDownloads}</TabsContent>
        <TabsContent value="articles">{articles}</TabsContent>
        <TabsContent value="network">{network}</TabsContent>
        <TabsContent value="events">{events}</TabsContent>
      </Tabs>
    </div>
  );
}
