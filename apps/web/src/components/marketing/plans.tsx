import Link from 'next/link';
import { Check } from 'lucide-react';
import type { Locale } from '@milyonuse/contracts';
import { getDictionary } from '@/i18n';

/** The plans, shared by the landing page and the pricing page. */
export function Plans({ locale }: { locale: Locale }) {
  const p = getDictionary(locale).marketing.pricing;
  return (
    <>
      <div className="mk-plans">
        {p.plans.map((plan) => {
          const featured = 'featured' in plan && plan.featured === true;
          return (
            <article key={plan.name} className="mk-plan" data-featured={featured ? 'true' : 'false'}>
              <header>
                <h3 className="mk-plan-name mk-serif">{plan.name}</h3>
                <p className="mk-plan-blurb">{plan.blurb}</p>
              </header>
              <p className="mk-plan-price">{p.tba}</p>
              <ul className="mk-plan-features">
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={16} strokeWidth={2} aria-hidden="true" />
                    {feature}
                  </li>
                ))}
              </ul>
              <Link href={`/register?lang=${locale}`} className={featured ? 'mk-cta' : 'mk-ghost'}>
                {p.cta}
              </Link>
            </article>
          );
        })}
      </div>
      <p className="mk-note">{p.note}</p>
    </>
  );
}
