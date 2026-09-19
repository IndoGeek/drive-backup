'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Info, Loader2, Save } from 'lucide-react';
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
      <div className="flex items-end justify-between">
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
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor={field.key}>{field.label}</Label>
                      {field.type === 'boolean' && (
                        <Switch
                          checked={Boolean(values[field.key])}
                          onCheckedChange={(v) => setValue(field.key, v)}
                          disabled={!editable}
                        />
                      )}
                    </div>
                    <FieldControl
                      field={field}
                      value={values[field.key]}
                      onChange={(v) => setValue(field.key, v)}
                      disabled={!editable}
                    />
                    {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
