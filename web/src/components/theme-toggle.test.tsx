import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { ThemeToggle } from "./theme-toggle";

describe("ThemeToggle", () => {
  it("toggles the `dark` class on the document root", async () => {
    const user = userEvent.setup();
    document.documentElement.classList.remove("dark");
    renderWithProviders(<ThemeToggle />);

    const button = screen.getByRole("button");
    const wasDark = document.documentElement.classList.contains("dark");

    await user.click(button);
    expect(document.documentElement.classList.contains("dark")).toBe(!wasDark);

    await user.click(button);
    expect(document.documentElement.classList.contains("dark")).toBe(wasDark);
  });
});
