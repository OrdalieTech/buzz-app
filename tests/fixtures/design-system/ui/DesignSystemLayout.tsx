import {
  MoonIcon,
  SunIcon,
} from "../../../../src/shared/design-system/icons/index";
import {
  Link,
  Outlet,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useColorScheme } from "../../../../src/shared/design-system/theme/useColorScheme";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";
import { COMPONENTS } from "../../../../src/shared/design-system/ui/registry";

type NavItem = [label: string, to: string, children?: NavItem[]];

type NavSection = { heading: string; items: NavItem[] };

function componentNavItems(
  collection: "components" | "product-ui",
  parent?: string,
): NavItem[] {
  return COMPONENTS.filter(
    (component) =>
      component.collection === collection && component.parent === parent,
  ).map((component) => [
    component.name,
    `/design/components/${component.slug}`,
    componentNavItems(collection, component.slug),
  ]);
}

const SECTIONS: NavSection[] = [
  {
    heading: "Foundations",
    items: [
      ["Color", "/design/color", [["Token table", "/design/color/table"]]],
      ["Typography", "/design/typography"],
      ["Icons", "/design/icons"],
      ["Spacing", "/design/spacing"],
      ["Radius", "/design/radius"],
      ["Elevation", "/design/elevation"],
      ["Floating surfaces", "/design/floating-surfaces"],
      ["Glass", "/design/glass"],
      ["Motion", "/design/motion"],
    ],
  },
  {
    heading: "Patterns",
    items: [
      ["Forms", "/design/forms"],
      ["Messages", "/design/messages"],
    ],
  },
  {
    heading: "Guides",
    items: [
      ["Design guide", "/design/design-guide"],
      ["Base UI backing", "/design/components/base-ui"],
    ],
  },
  {
    heading: "Components",
    items: [
      ["All components", "/design/components", componentNavItems("components")],
    ],
  },
  {
    heading: "Layout playgrounds",
    items: componentNavItems("product-ui"),
  },
];

function NavLink({
  to,
  exact,
  children,
  onNavigate,
}: {
  to: string;
  exact?: boolean;
  children: ReactNode;
  onNavigate: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      {...(exact ? { activeOptions: { exact: true } } : {})}
      className="design-system-nav-link text-body text-primary"
      activeProps={{
        className:
          "design-system-nav-link design-system-nav-link-active text-body text-primary",
      }}
    >
      {children}
    </Link>
  );
}

function NavItems({
  items,
  onNavigate,
  depth = 0,
}: {
  items: NavItem[];
  onNavigate: () => void;
  depth?: number;
}) {
  return (
    <div className="design-system-nav-items">
      {items.map(([label, to, children]) => (
        <Fragment key={to}>
          <div className={depth ? "design-system-nav-child" : undefined}>
            <NavLink
              to={to}
              onNavigate={onNavigate}
              exact={children !== undefined && children.length > 0}
            >
              {label}
            </NavLink>
          </div>
          {children?.length ? (
            <NavItems
              items={children}
              depth={depth + 1}
              onNavigate={onNavigate}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

function routeLabel(items: NavItem[], path: string): string | undefined {
  for (const [label, to, children] of items) {
    if (to === path) return label;
    const child = children && routeLabel(children, path);
    if (child) return child;
  }
}

/** `children` is for the not-found shell, which renders outside the route tree. */
export function DesignSystemLayout({ children }: { children?: ReactNode }) {
  const { scheme, toggle, persistenceError } = useColorScheme();
  const router = useRouter();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const [contents, setContents] = useState<HTMLElement[]>([]);
  const focusAfterNavigation = useRef(false);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const currentPage =
    routeLabel(
      SECTIONS.flatMap((section) => section.items),
      pathname,
    ) ?? "Overview";
  const focusContent = () => {
    main.current?.focus();
    main.current?.scrollIntoView();
  };
  const closeNavigation = () => {
    if (navigationOpen) {
      setNavigationOpen(false);
      focusAfterNavigation.current = true;
    }
  };
  useLayoutEffect(() => {
    if (!navigationOpen && focusAfterNavigation.current) {
      focusAfterNavigation.current = false;
      main.current?.focus();
      main.current?.scrollIntoView();
    }
  }, [navigationOpen]);

  useLayoutEffect(() => {
    const readContents = () => {
      setContents(
        Array.from(
          main.current?.querySelectorAll<HTMLElement>(
            ".design-section-heading h2, .component-specimen-group > h2, .design-doc > h2",
          ) ?? [],
        ),
      );
    };
    readContents();
    // Location changes before the outlet commits its next page. Read headings
    // at the router's render boundary so the rail always targets mounted content.
    return router.subscribe("onRendered", readContents);
  }, [router]);

  return (
    <div className="design-system-shell">
      <button
        type="button"
        className="design-system-skip text-body"
        onClick={focusContent}
      >
        Skip to content
      </button>
      <nav aria-label="Design system" className="design-system-nav">
        <div className="design-system-nav-header">
          <Link
            to="/design"
            onClick={closeNavigation}
            className="design-system-nav-title design-system-nav-link text-body text-primary"
          >
            Buzz Design System
          </Link>
          <IconButton
            aria-label={scheme === "dark" ? "Use light mode" : "Use dark mode"}
            icon={
              scheme === "dark" ? (
                <SunIcon size={16} aria-hidden="true" />
              ) : (
                <MoonIcon size={16} aria-hidden="true" />
              )
            }
            size="toolbar"
            onClick={toggle}
          />
        </div>
        <button
          type="button"
          className="design-system-nav-toggle text-body text-primary"
          aria-expanded={navigationOpen}
          aria-controls="design-system-navigation"
          onClick={() => setNavigationOpen(!navigationOpen)}
        >
          <span>{navigationOpen ? "Hide pages" : "Browse pages"}</span>
          <span className="text-secondary">{currentPage}</span>
        </button>
        <div aria-hidden="true" className="design-system-nav-rule" />
        <div
          id="design-system-navigation"
          className="design-system-nav-sections"
          data-open={navigationOpen}
        >
          {SECTIONS.map((section) => (
            <section
              className="design-system-nav-section"
              key={section.heading}
            >
              <h2 className="text-body text-tertiary">{section.heading}</h2>
              <NavItems items={section.items} onNavigate={closeNavigation} />
            </section>
          ))}
        </div>
      </nav>
      <main
        id="design-system-main"
        tabIndex={-1}
        ref={main}
        className="design-system-content"
        data-contents={contents.length > 1}
      >
        <div className="design-system-reading-column">
          {persistenceError ? (
            <p role="status" className="text-body text-secondary">
              Appearance is temporary because browser storage is unavailable.
              Toggle again to retry saving.
            </p>
          ) : null}
          {children ?? <Outlet />}
        </div>
        {contents.length > 1 && (
          <nav aria-label="On this page" className="design-system-contents">
            <p className="text-label-sm text-primary">On this page</p>
            <div className="design-system-contents-links">
              {contents.map((heading) => (
                <button
                  key={`${pathname}-${heading.textContent}`}
                  type="button"
                  className="text-body-sm text-secondary"
                  onClick={() => {
                    heading.tabIndex = -1;
                    heading.focus({ preventScroll: true });
                    heading.scrollIntoView({ block: "start" });
                  }}
                >
                  {heading.textContent}
                </button>
              ))}
            </div>
          </nav>
        )}
      </main>
    </div>
  );
}
