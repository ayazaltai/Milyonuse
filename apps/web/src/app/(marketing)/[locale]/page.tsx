import Link from 'next/link';
import {
  ArrowUpRight,
  Bot,
  BrainCircuit,
  CalendarClock,
  Fingerprint,
  History,
  Link2,
  MessagesSquare,
  Plus,
  ShieldCheck,
  Undo2,
  UserCheck,
  Users,
  Wrench,
  Zap,
} from 'lucide-react';
import { isLocale } from '@milyonuse/contracts';
import { notFound } from 'next/navigation';
import { Plans } from '@/components/marketing/plans';
import { getDictionary } from '@/i18n';

const CAPABILITY_ICONS = [Bot, Users, CalendarClock, Zap, MessagesSquare, Wrench];
const TRUST_ICONS = [Fingerprint, BrainCircuit, History, Undo2, UserCheck, ShieldCheck];

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const m = t.marketing;

  return (
    <>
      <section className="mk-hero" aria-labelledby="hero-title">
        <span className="mk-badge">
          <span className="mk-badge-dot" aria-hidden="true" />
          {m.hero.badge}
        </span>
        <h1 id="hero-title" className="mk-h1">
          <span>{m.hero.titleTop}</span>
          <span className="mk-serif mk-gradient">{m.hero.titleAccent}</span>
        </h1>
        <div className="mk-kicker">
          {m.hero.kicker.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div className="mk-hero-actions">
          <Link href={`/register?lang=${locale}`} className="mk-cta mk-cta-lg">
            {m.hero.primary}
            <ArrowUpRight size={16} strokeWidth={2} />
          </Link>
          <a href="#how" className="mk-ghost">
            {m.hero.secondary}
          </a>
        </div>
        <ul className="mk-chips" style={{ listStyle: 'none', padding: 0 }}>
          {m.hero.chips.map((chip) => (
            <li key={chip} className="mk-chip">
              {chip}
            </li>
          ))}
        </ul>
      </section>

      <section id="how" className="mk-section" aria-labelledby="how-title">
        <div className="mk-inner">
          <header className="mk-head">
            <p className="mk-eyebrow">{m.how.eyebrow}</p>
            <h2 id="how-title" className="mk-h2">
              <span>{m.how.titleTop}</span>
              <span className="mk-serif">{m.how.titleAccent}</span>
            </h2>
          </header>
          <ol className="mk-steps" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {m.how.steps.map((step, index) => (
              <li key={step.title} className="mk-card">
                <span className="mk-step-number">0{index + 1}</span>
                <h3 className="mk-card-title mk-serif">{step.title}</h3>
                <p className="mk-card-text">{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="capabilities" className="mk-section" aria-labelledby="capabilities-title">
        <div className="mk-inner">
          <header className="mk-head">
            <p className="mk-eyebrow">{m.capabilities.eyebrow}</p>
            <h2 id="capabilities-title" className="mk-h2">
              <span>{m.capabilities.titleTop}</span>
              <span className="mk-serif">{m.capabilities.titleAccent}</span>
            </h2>
          </header>
          <ul className="mk-grid" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {m.capabilities.items.map((item, index) => {
              const Icon = CAPABILITY_ICONS[index] ?? Link2;
              return (
                <li key={item.title} className="mk-cell">
                  <span className="mk-cell-icon" aria-hidden="true">
                    <Icon size={18} strokeWidth={1.7} />
                  </span>
                  <h3 className="mk-cell-title">{item.title}</h3>
                  <p className="mk-cell-text">{item.text}</p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section id="trust" className="mk-section mk-trust" aria-labelledby="trust-title">
        <div className="mk-inner mk-trust-layout">
          <header>
            <p className="mk-eyebrow">{m.trust.eyebrow}</p>
            <h2 id="trust-title" className="mk-h2">
              <span>{m.trust.titleTop}</span>
              <span className="mk-serif">{m.trust.titleAccent}</span>
            </h2>
            <p className="mk-lead">{m.trust.lead}</p>
          </header>
          <ul className="mk-points">
            {m.trust.points.map((point, index) => {
              const Icon = TRUST_ICONS[index] ?? ShieldCheck;
              return (
                <li key={point.title} className="mk-point">
                  <Icon size={18} strokeWidth={1.7} className="mk-point-icon" aria-hidden="true" />
                  <span>
                    <span className="mk-point-title">{point.title}</span>
                    <span className="mk-point-text">{point.text}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section id="pricing" className="mk-section" aria-labelledby="pricing-title">
        <div className="mk-inner">
          <header className="mk-head mk-head-center">
            <p className="mk-eyebrow">{m.pricing.eyebrow}</p>
            <h2 id="pricing-title" className="mk-h2">
              <span>{m.pricing.titleTop}</span>
              <span className="mk-serif">{m.pricing.titleAccent}</span>
            </h2>
          </header>
          <Plans locale={locale} />
        </div>
      </section>

      <section id="faq" className="mk-section" aria-labelledby="faq-title">
        <div className="mk-inner">
          <header className="mk-head mk-head-center">
            <p className="mk-eyebrow">{m.faq.eyebrow}</p>
            <h2 id="faq-title" className="mk-h2">
              <span>{m.faq.titleTop}</span>
              <span className="mk-serif">{m.faq.titleAccent}</span>
            </h2>
          </header>
          <div className="mk-faq">
            {m.faq.items.map((item) => (
              <details key={item.q}>
                <summary>
                  {item.q}
                  <Plus size={18} strokeWidth={1.6} aria-hidden="true" />
                </summary>
                <p className="mk-faq-answer">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="mk-closing" aria-labelledby="closing-title">
        <h2 id="closing-title" className="mk-h2">
          <span>{m.closing.titleTop}</span>
          <span className="mk-serif mk-gradient">{m.closing.titleAccent}</span>
        </h2>
        <p className="mk-lead" style={{ marginLeft: 'auto', marginRight: 'auto' }}>
          {m.closing.lead}
        </p>
        <div className="mk-hero-actions">
          <Link href={`/register?lang=${locale}`} className="mk-cta mk-cta-lg">
            {m.closing.cta}
            <ArrowUpRight size={16} strokeWidth={2} />
          </Link>
        </div>
      </section>
    </>
  );
}
