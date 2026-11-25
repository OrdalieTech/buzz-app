import type { ReactNode } from "react";

/**
 * Presentation pieces for the design system pages only. These are documentation
 * furniture, not product components — the shared primitive layer gets built one
 * component at a time as the product repeats something.
 *
 * Surface convention on these pages: a region is separated by a soft fill, not
 * by an outline. Reach for `bg-neutral-2` before reaching for a border; use a
 * hairline only where a genuine boundary is needed, and never above
 * `border-primary`. See DESIGN.md § Surface and depth.
 */

export function PageHeader({
  title,
  intro,
  status,
  children,
}: {
  title: string;
  intro?: ReactNode;
  status?: string;
  children?: ReactNode;
}) {
  return (
    <header className="design-page-header">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-title text-primary">{title}</h1>
        {status ? <StatusPill>{status}</StatusPill> : null}
      </div>
      {intro ? (
        <p className="design-page-intro text-body text-secondary">{intro}</p>
      ) : null}
      {children}
    </header>
  );
}

/**
 * Marks a token as `proposed` on the /design pages.
 *
 * Amber, until the status roles it borrowed were deleted as undesigned. It is
 * the accent now, which is arguably more honest: "proposed" is a note about
 * this system, not a warning about the interface.
 */
export function StatusPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-purple-3 px-2.5 py-1 text-body-sm text-purple-12">
      {children}
    </span>
  );
}

/** One heading treatment for foundation, pattern, and component documentation. */
export function SectionHeading({
  title,
  description,
  id,
}: {
  title: string;
  description?: string | undefined;
  id?: string;
}) {
  return (
    <header className="design-section-heading">
      <h2 id={id} className="text-label text-primary">
        {title}
      </h2>
      {description ? (
        <p className="design-section-description text-body text-secondary">
          {description}
        </p>
      ) : null}
    </header>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className="design-section">
      <SectionHeading title={title} description={description} />
      <div className="design-section-content">{children}</div>
    </section>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-2xl rounded-xl bg-neutral-2 px-5 py-4 text-body-sm text-secondary">
      {children}
    </p>
  );
}

export function Stub({ what, decide }: { what: string; decide: string[] }) {
  return (
    <div className="flex max-w-2xl flex-col gap-4 rounded-xl bg-neutral-2 px-6 py-5">
      <p className="text-body text-secondary">{what}</p>
      <div className="flex flex-col gap-2">
        <p className="text-body text-tertiary">Still to decide</p>
        <ul className="flex list-disc flex-col gap-1.5 ps-4">
          {decide.map((item) => (
            <li key={item} className="text-body-sm text-secondary">
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * A list of uniform rows — the tabular case, where every row looks alike and the
 * eye needs a line to track along. Dividers, no container: the section heading
 * already says these belong together, so a fill behind them adds a box without
 * adding meaning.
 *
 * If the rows carry their own visual difference — a swatch, a type specimen — use
 * `Specimens` instead. Content that separates itself needs no divider.
 */
export function Rows({ children }: { children: ReactNode }) {
  return <div className="flex flex-col">{children}</div>;
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <div className="border-primary border-b py-3 last:border-b-0">
      {children}
    </div>
  );
}

/**
 * A list whose entries are visibly different from each other — colour swatches,
 * type specimens, elevation samples.
 *
 * No container and no dividers. The specimen is its own separator, and two
 * things a colour system must never do are judge a swatch against a fill it
 * will never sit on, or set a type specimen in a box that changes its contrast.
 * Separation comes from space alone.
 */
export function Specimens({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-8">{children}</div>;
}

/** Renders a live swatch of whatever a CSS custom property currently holds. */
export function Swatch({
  variable,
  label,
  sublabel,
  translucent,
}: {
  variable: string;
  label: string;
  sublabel?: string | undefined;
  translucent?: boolean | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className={`h-16 rounded-lg border-primary border ${
          translucent ? "blur-chrome" : ""
        }`}
        style={{ background: `var(${variable})` }}
      />
      <code className="break-words text-mono text-primary">{label}</code>
      {sublabel ? (
        <span className="text-body-sm text-tertiary">{sublabel}</span>
      ) : null}
    </div>
  );
}
