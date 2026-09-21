'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, HelpCircle, Info, Loader2, Save, X } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Switch,
  Textarea,
} from '@/components/ui';
import { CONFIG_SECTIONS, type Field } from '@/lib/schema';
import { useMe } from '@/lib/use-me';

function readPath(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function FieldControl({
  field,
  value,
  onChange,
  disabled,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  switch (field.type) {
    case 'boolean':
      return null;
    case 'select':
      return (
        <Select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        >
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case 'string[]':
      return (
        <Textarea
          value={Array.isArray(value) ? value.join('\n') : String(value ?? '')}
          onChange={(e) => onChange(e.target.value.split('\n'))}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      );
    case 'number':
      return (
        <Input
          type="number"
          step="any"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      );
    case 'password':
      return (
        <Input
          type="password"
          autoComplete="new-password"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      );
    default:
      return (
        <Input
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      );
  }
}

export default function ConfigPage() {
  const { loading: meLoading, can } = useMe();
  const editable = can('config.edit');

  const [loaded, setLoaded] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [helpField, setHelpField] = useState<Field | null>(null);

  useEffect(() => {
    if (!helpField) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHelpField(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpField]);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/config');
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? 'cannot read config.yml');
        setLoaded(true);
        return;
      }
      const data = (await res.json()) as { config?: Record<string, unknown> };
      const cfg = data.config ?? {};
      const init: Record<string, unknown> = {};
      for (const section of CONFIG_SECTIONS) {
        for (const field of section.fields) init[field.key] = readPath(cfg, field.key);
      }
      setValues(init);
      setLoaded(true);
    })();
  }, []);

  function setValue(key: string, v: unknown) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      const data = (await res.json()) as { updated?: string[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Save failed');
        return;
      }
      setMessage(
        `Saved ${data.updated?.length ?? 0} setting(s). Restart the daemon to apply them.`,
      );
    } finally {
      setSaving(false);
    }
  }

  if (!meLoading && !can('config.view')) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        Your account does not have the <code className="font-mono">config.view</code> permission.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Configuration</h1>
          <p className="text-sm text-muted-foreground">
            Edits <code className="font-mono">config.yml</code> in place and preserves comments.
            Scheduling lives on the Dashboard.
          </p>
        </div>
        <Button onClick={save} disabled={!loaded || saving || !editable}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save changes
        </Button>
      </div>

      {!editable && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          You have read-only access (no <code className="font-mono">config.edit</code> permission).
        </div>
      )}

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          The daemon reads <code className="font-mono">config.yml</code> at start, so run{' '}
          <code className="font-mono">pm2 restart backup-mgr</code> after saving.
        </span>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-success">{message}</p>}

      {!loaded ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading configuration…
        </p>
      ) : (
        <div className="space-y-6">
          {CONFIG_SECTIONS.map((section) => (
            <Card key={section.id}>
              <CardHeader>
                <CardTitle>{section.title}</CardTitle>
                {section.description && <CardDescription>{section.description}</CardDescription>}
              </CardHeader>
              <CardContent className="grid gap-5 md:grid-cols-2">
                {section.fields.map((field) => (
                  <div key={field.key} className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
                      <Label htmlFor={field.key}>{field.label}</Label>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setHelpField(field)}
                          aria-label={`Help for ${field.label}`}
                          title="What does this do?"
                          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <HelpCircle className="h-4 w-4" />
                        </button>
                        {field.type === 'boolean' && (
                          <Switch
                            checked={Boolean(values[field.key])}
                            onCheckedChange={(v) => setValue(field.key, v)}
                            disabled={!editable}
                          />
                        )}
                      </div>
                    </div>
                    <FieldControl
                      field={field}
                      value={values[field.key]}
                      onChange={(v) => setValue(field.key, v)}
                      disabled={!editable}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {helpField && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Help for ${helpField.label}`}
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setHelpField(null)}
            aria-hidden="true"
          />
          <div className="relative z-10 max-h-[85vh] w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background shadow-xl">
            <div className="flex items-start justify-between gap-4 border-b border-border bg-muted/30 p-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold leading-tight">{helpField.label}</h2>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">{helpField.key}</p>
              </div>
              <button
                type="button"
                onClick={() => setHelpField(null)}
                aria-label="Close help"
                className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[55vh] overflow-y-auto p-4">
              {helpField.help ? (
                <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                  {helpField.help}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No additional help is available for this option.
                </p>
              )}
            </div>
            <div className="flex justify-end border-t border-border p-3">
              <Button variant="outline" size="sm" onClick={() => setHelpField(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
