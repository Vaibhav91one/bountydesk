/** The card, empty state and label row the settings tabs are built from. */

export function Panel({
  title,
  detail,
  aside,
  children,
}: {
  title: string;
  detail: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border/50 bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-heading text-foreground">{title}</h2>
          <p className="max-w-2xl text-meta text-muted-foreground">{detail}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-body text-muted-foreground">{children}</p>;
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="min-w-0 text-body text-foreground">{children}</span>
    </div>
  );
}
