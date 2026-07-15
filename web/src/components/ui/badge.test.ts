import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { badgeVariants } from "./badge";

type Rgb = [number, number, number];
const themeCss = readFileSync("src/index.css", "utf8");

describe("Badge success variant", () => {
  it("uses semantic theme tokens whose normal-text contrast meets WCAG AA", () => {
    expect(badgeVariants({ variant: "success" })).toContain(
      "bg-success/15 text-success-foreground",
    );

    const light = themeBlock(":root");
    const dark = themeBlock(".dark");

    expect(successContrast(light)).toBeGreaterThanOrEqual(4.5);
    expect(successContrast(dark)).toBeGreaterThanOrEqual(4.5);
  });
});

function successContrast(block: string): number {
  const page = hslToRgb(variable(block, "background"));
  const tint = hslToRgb(variable(block, "success"));
  const foreground = hslToRgb(variable(block, "success-foreground"));
  return contrast(foreground, composite(tint, page, 0.15));
}

function themeBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = themeCss.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`Missing ${selector} theme block`);
  return match[1];
}

function variable(block: string, name: string): [number, number, number] {
  const match = block.match(
    new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`),
  );
  if (!match) throw new Error(`Missing --${name} theme variable`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hslToRgb([hue, saturation, lightness]: [number, number, number]): Rgb {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = l - chroma / 2;
  const [red, green, blue] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return [red + offset, green + offset, blue + offset];
}

function composite(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map(
    (channel, index) => channel * alpha + background[index] * (1 - alpha),
  ) as Rgb;
}

function contrast(first: Rgb, second: Rgb): number {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function luminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}
