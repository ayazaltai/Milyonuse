'use client';

import { useState } from 'react';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';

/**
 * A password input with a way to read back what was typed — on a phone
 * keyboard especially, where one wrong key otherwise means starting over.
 * Shown only on request, and hidden again by the same button.
 */
export function PasswordInput({
  value,
  onChange,
  autoComplete,
  labels,
  name = 'password',
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  /** `current-password` to sign in, `new-password` to set one — what a password manager keys on. */
  autoComplete: 'current-password' | 'new-password';
  labels: { show: string; hide: string };
  name?: string;
  autoFocus?: boolean;
}) {
  const [shown, setShown] = useState(false);

  return (
    <span className="control-wrap has-reveal">
      <LockKeyhole size={16} strokeWidth={1.7} />
      <input
        type={shown ? 'text' : 'password'}
        name={name}
        required
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        spellCheck={false}
        autoCapitalize="none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="control control-lg"
      />
      <button
        type="button"
        className="control-reveal"
        onClick={() => setShown(!shown)}
        aria-label={shown ? labels.hide : labels.show}
        aria-pressed={shown}
      >
        {shown ? <EyeOff size={16} strokeWidth={1.7} /> : <Eye size={16} strokeWidth={1.7} />}
      </button>
    </span>
  );
}

/**
 * The link an account mail carries, shown on the page instead — only while
 * this deployment writes mail to its log (development). Production never
 * returns one.
 */
export function DevelopmentLink({ href, text, action }: { href: string | undefined; text: string; action: string }) {
  if (!href) return null;
  return (
    <p className="auth-trust" style={{ marginTop: 16 }}>
      <span>
        {text}{' '}
        <a href={href} className="link-quiet" style={{ color: 'var(--w-80)' }}>
          {action}
        </a>
        .
      </span>
    </p>
  );
}
