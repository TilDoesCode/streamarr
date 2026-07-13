import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GeneralSettings } from "./general-settings";
import { ApiKeysSettings } from "./api-keys-settings";
import { PasswordSettings } from "./password-settings";

export function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
        <p className="text-sm text-muted-foreground">
          General configuration, machine API keys, and your admin password (BRIEF §9.1).
        </p>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="apikeys">API keys</TabsTrigger>
          <TabsTrigger value="password">Password</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <GeneralSettings />
        </TabsContent>
        <TabsContent value="apikeys">
          <ApiKeysSettings />
        </TabsContent>
        <TabsContent value="password">
          <PasswordSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}
