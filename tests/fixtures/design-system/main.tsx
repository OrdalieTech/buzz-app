import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "../../../src/shared/design-system/styles/globals.css";
import "./styles.css";
import { useKeyboardFocusVisibility } from "../../../src/shared/design-system/useKeyboardFocusVisibility";
import { applyStoredColorScheme } from "../../../src/shared/design-system/theme/useColorScheme";
import { DesignSystemLayout } from "./ui/DesignSystemLayout";
import { FormsPage } from "./ui/FormsPage";
import { OverviewPage } from "./ui/OverviewPage";
import { ComponentDetailPage } from "./ui/ComponentDetailPage";
import { ComponentsPage } from "./ui/ComponentsPage";
import { ColorPage } from "./ui/ColorPage";
import { ColorTablePage } from "./ui/ColorTablePage";
import { TypographyPage } from "./ui/TypographyPage";
import { SpacingPage } from "./ui/SpacingPage";
import { RadiusPage } from "./ui/RadiusPage";
import { IconsPage } from "./ui/IconsPage";
import { FloatingSurfacesPage } from "./ui/FloatingSurfacesPage";
import { ElevationPage } from "./ui/ElevationPage";
import { GlassPage } from "./ui/GlassPage";
import { MotionPage } from "./ui/MotionPage";
import { BaseUiPage } from "./ui/BaseUiPage";
import { SystemDocumentPage } from "./ui/SystemDocumentPage";
import { MessagesPage } from "./ui/MessagesPage";
import { MissingPage } from "./ui/MissingPage";

// Explicit design-only routes: no import of the app route tree or native startup.
// Hash history keeps deep links reloadable on a static file host.
applyStoredColorScheme();
const rootRoute = createRootRoute({ component: Outlet });
const design = createRoute({
  getParentRoute: () => rootRoute,
  path: "design",
  component: DesignSystemLayout,
});
const detail = createRoute({
  getParentRoute: () => design,
  path: "components/$component",
  component: () => <ComponentDetailPage slug={detail.useParams().component} />,
});
const pages = [
  createRoute({
    getParentRoute: () => design,
    path: "forms",
    component: FormsPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "/",
    component: OverviewPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "components",
    component: ComponentsPage,
  }),
  detail,
  createRoute({
    getParentRoute: () => design,
    path: "messages",
    component: MessagesPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "components/base-ui",
    component: BaseUiPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "color",
    component: ColorPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "color/table",
    component: ColorTablePage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "icons",
    component: IconsPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "typography",
    component: TypographyPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "spacing",
    component: SpacingPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "radius",
    component: RadiusPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "elevation",
    component: ElevationPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "floating-surfaces",
    component: FloatingSurfacesPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "glass",
    component: GlassPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "motion",
    component: MotionPage,
  }),
  createRoute({
    getParentRoute: () => design,
    path: "design-guide",
    component: () => <SystemDocumentPage document="design" />,
  }),
];
if (!window.location.hash || window.location.hash === "#/") {
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#/design/`,
  );
}
const missing = createRoute({
  getParentRoute: () => design,
  path: "$",
  component: MissingPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([design.addChildren([...pages, missing])]),
  history: createHashHistory(),
  defaultNotFoundComponent: () => (
    <DesignSystemLayout>
      <MissingPage />
    </DesignSystemLayout>
  ),
});
function Viewer() {
  useKeyboardFocusVisibility();
  return <RouterProvider router={router} />;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing viewer root");
createRoot(root).render(
  <StrictMode>
    <Viewer />
  </StrictMode>,
);
