// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BrowserIcon } from "../../shared/design-system/icons/index";
import { PageIcon, paintsCurrentColor } from "./PageIcon";

afterEach(() => {
  cleanup();
});

const owl = "data:image/svg+xml,%3Csvg%20id%3D%22owl%22%3E%3C%2Fsvg%3E";
const fox = "data:image/png;base64,iVBORfox";

it("renders a declared image as a decorative, non-draggable img", () => {
  const { container } = render(
    <PageIcon icon={BrowserIcon} image={owl} size={17} />,
  );
  const image = container.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", owl);
  expect(image).toHaveAttribute("alt", "");
  expect(image).toHaveAttribute("aria-hidden", "true");
  // A native image drag that starts on the icon swallows the row's click.
  expect(image).toHaveAttribute("draggable", "false");
});

it("swaps in the component icon when the image fails to load", () => {
  const { container } = render(
    <PageIcon icon={BrowserIcon} image={owl} size={17} />,
  );
  const image = container.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", owl);
  fireEvent.error(image as Element);
  expect(container.querySelector("img")).toBeNull();
  const fallback = container.querySelector("svg");
  expect(fallback).toBeInstanceOf(SVGSVGElement);
  expect(fallback).toHaveAttribute("aria-hidden", "true");
});

it("stays on the fallback when rerendered with the source that failed", () => {
  const { container, rerender } = render(
    <PageIcon icon={BrowserIcon} image={owl} size={17} />,
  );
  const image = container.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", owl);
  fireEvent.error(image as Element);
  rerender(<PageIcon icon={BrowserIcon} image={owl} size={17} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).toBeInstanceOf(SVGSVGElement);
});

it("tries a new source once after an earlier source failed", () => {
  const { container, rerender } = render(
    <PageIcon icon={BrowserIcon} image={owl} size={17} />,
  );
  const image = container.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", owl);
  fireEvent.error(image as Element);
  rerender(<PageIcon icon={BrowserIcon} image={fox} size={17} />);
  const retried = container.querySelector("img");
  expect(retried).toBeInstanceOf(HTMLImageElement);
  expect(retried).toHaveAttribute("src", fox);
  expect(container.querySelector("svg")).toBeNull();
});

it("renders the component icon at the given size when no image is declared", () => {
  const { container } = render(<PageIcon icon={BrowserIcon} size={17} />);
  const icon = container.querySelector("svg");
  expect(icon).toBeInstanceOf(SVGSVGElement);
  // The icon gateway renders numeric sizes in rem: 17 / 16.
  expect(icon).toHaveAttribute("width", "1.0625rem");
  expect(icon).toHaveAttribute("aria-hidden", "true");
  expect(container.querySelector("img")).toBeNull();
});

const bag = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" stroke="currentColor"><path d="M1 1"/></svg>')}`;
const bag64 = `data:image/svg+xml;charset=utf-8;base64,${btoa('<svg fill="currentcolor"/>')}`;

it("tells SVGs that paint with currentColor from other images", () => {
  expect(paintsCurrentColor(bag)).toBe(true);
  expect(paintsCurrentColor(bag64)).toBe(true);
  expect(paintsCurrentColor(owl)).toBe(false);
  expect(paintsCurrentColor(fox)).toBe(false);
  const styled =
    '<svg><style>path{stroke: currentColor}</style><path d="M1 1"/></svg>';
  expect(
    paintsCurrentColor(`data:image/svg+xml,${encodeURIComponent(styled)}`),
  ).toBe(true);
  const named =
    '<svg><title>currentColor example</title><!-- fill="currentColor" --><path fill="red"/><path fill="blue"/></svg>';
  expect(
    paintsCurrentColor(`data:image/svg+xml,${encodeURIComponent(named)}`),
  ).toBe(false);
  expect(paintsCurrentColor("data:image/svg+xml,%E0%A4%A")).toBe(false);
  expect(paintsCurrentColor("data:image/svg+xml;base64,@@@")).toBe(false);
});

it("draws a currentColor SVG as a mask in the text colour", () => {
  const { container } = render(
    <PageIcon icon={BrowserIcon} image={bag} size={16} />,
  );
  const mask = container.firstElementChild as HTMLElement;
  expect(mask.tagName).toBe("SPAN");
  expect(mask).toHaveClass("bg-current");
  expect(mask).toHaveAttribute("aria-hidden", "true");
  expect(mask.getAttribute("style")).toContain(`url("${bag}")`);
  expect(mask.style.width).toBe("1rem");
  const probe = mask.querySelector("img");
  expect(probe).toHaveAttribute("src", bag);
  expect(probe).not.toBeVisible();
});

it("swaps in the component icon when a masked SVG fails to load", () => {
  const { container } = render(
    <PageIcon icon={BrowserIcon} image={bag64} size={16} />,
  );
  fireEvent.error(container.querySelector("img") as Element);
  expect(container.querySelector("span")).toBeNull();
  expect(container.querySelector("svg")).toBeInstanceOf(SVGSVGElement);
});
