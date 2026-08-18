import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { SettingsPage } from "./index";

vi.mock("./general-settings", () => ({ GeneralSettings: () => <div>General settings panel</div> }));
vi.mock("./pre-download-settings", () => ({
  PreDownloadSettings: () => <div>Pre-download settings panel</div>,
}));
vi.mock("./notification-settings", () => ({
  NotificationSettings: () => <div>Notification settings panel</div>,
}));
vi.mock("./api-keys-settings", () => ({ ApiKeysSettings: () => <div>API key settings panel</div> }));
vi.mock("./password-settings", () => ({ PasswordSettings: () => <div>Password settings panel</div> }));

describe("SettingsPage", () => {
  it("opens the dedicated pre-download settings tab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    expect(screen.getByText("General settings panel")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Pre-download" }));

    expect(screen.getByText("Pre-download settings panel")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Pre-download" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
