"use client";

import { useState, useTransition } from "react";

import { Gear, Plus, Trash } from "@phosphor-icons/react/ssr";

import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { OutsideConfig } from "@/lib/email/outside-config";

import { saveOutsideConfig } from "./email-config-actions";

/**
 * Owner-only editor for the outside-intake limits and the per-domain exempt list.
 *
 * The three limits bound outbound mail to unverified senders; the exempt list names the free-mail
 * domains that should not share one per-domain bucket between unrelated people. The dialog mirrors
 * the reviewer-access one: a controlled Dialog, a transition around the server action, and an
 * add/remove row list for the domains, because there is no multi-value input primitive.
 */
export function ConfigureEmailIntake({ config }: { config: OutsideConfig }) {
  const [open, setOpen] = useState(false);
  const [perSender, setPerSender] = useState(String(config.perSenderPerDay));
  const [perDomain, setPerDomain] = useState(String(config.perDomainPerDay));
  const [maxKib, setMaxKib] = useState(String(Math.round(config.maxBytes / 1024)));
  const [domains, setDomains] = useState<string[]>(config.exemptDomains);
  const [newDomain, setNewDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setPerSender(String(config.perSenderPerDay));
    setPerDomain(String(config.perDomainPerDay));
    setMaxKib(String(Math.round(config.maxBytes / 1024)));
    setDomains(config.exemptDomains);
    setNewDomain("");
    setError(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  function addDomain() {
    const domain = newDomain.trim().toLowerCase();
    if (domain.length === 0) return;
    if (!domains.includes(domain)) setDomains([...domains, domain]);
    setNewDomain("");
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveOutsideConfig({
        perSenderPerDay: Number(perSender),
        perDomainPerDay: Number(perDomain),
        // The field is KiB for a human; the stored cap is bytes. NaN from an empty field flows
        // through and the server rejects it, so nothing has to be re-validated here.
        maxBytes: Math.round(Number(maxKib) * 1024),
        exemptDomains: domains,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <RollingIcon icon={Gear} className="size-4" />
            Configuration
          </Button>
        }
      />

      <DialogContent className="no-scrollbar flex max-h-[85vh] flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <DialogHeader className="gap-2 border-b border-border/50 p-6">
          <DialogTitle>Outside intake limits</DialogTitle>
          <DialogDescription>
            How much mail an unverified sender may send before it is dropped, and which domains are
            exempt from the shared per-domain limit.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 flex-col gap-5 p-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-meta text-muted-foreground">Per sender / day</span>
              <Input
                type="number"
                min={1}
                value={perSender}
                onChange={(event) => setPerSender(event.target.value)}
                className="h-10 border-border/50 text-body"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-meta text-muted-foreground">Per domain / day</span>
              <Input
                type="number"
                min={1}
                value={perDomain}
                onChange={(event) => setPerDomain(event.target.value)}
                className="h-10 border-border/50 text-body"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-meta text-muted-foreground">Size cap (KiB)</span>
              <Input
                type="number"
                min={1}
                value={maxKib}
                onChange={(event) => setMaxKib(event.target.value)}
                className="h-10 border-border/50 text-body"
              />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-meta text-muted-foreground">Exempt domains</span>
            <p className="text-meta text-muted-foreground">
              A domain here is not charged against the per-domain limit, so unrelated senders on a
              free-mail provider do not share one bucket. The per-sender limit and size cap still apply.
            </p>

            {domains.length > 0 ? (
              <ul className="flex flex-col rounded-md border border-border/50 bg-background px-4">
                {domains.map((domain) => (
                  <li
                    key={domain}
                    className="flex items-center justify-between gap-3 border-b border-border/50 py-2.5 last:border-b-0"
                  >
                    <span className="truncate text-body text-foreground">{domain}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setDomains(domains.filter((d) => d !== domain))}
                      aria-label={`Remove ${domain}`}
                    >
                      <RollingIcon icon={Trash} className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}

            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                addDomain();
              }}
            >
              <Input
                value={newDomain}
                onChange={(event) => setNewDomain(event.target.value)}
                placeholder="example.com"
                className="h-10 border-border/50 text-body"
              />
              <Button type="submit" variant="outline" disabled={pending || newDomain.trim().length === 0}>
                <RollingIcon icon={Plus} className="size-4" />
                Add
              </Button>
            </form>
          </div>

          {error ? <p className="text-meta text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="border-t border-border/50 p-6">
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
