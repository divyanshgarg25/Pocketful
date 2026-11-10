import React, { useCallback, useEffect, useState } from 'react';
import { getSecurityNotifications, type SecurityNotification } from '../lib/api';
import { logError } from '../lib/log';

const TITLE: Record<SecurityNotification['kind'], string> = {
  factor_enrolled: 'Verification method added',
  factor_replaced: 'Verification method changed',
  factor_removed: 'Verification method removed'
};

/**
 * Recent changes to the methods that approve money actions. If one of these was not you, that is the sign someone
 * else is in your account: the server also holds a newly added method back from approving money for a while.
 */
export const SecurityNotifications: React.FC = () => {
  const [items, setItems] = useState<SecurityNotification[] | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await getSecurityNotifications());
    } catch (err) {
      logError('Failed to load security notifications:', err);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!items || items.length === 0) return null;

  return (
    <section
      aria-labelledby="security-activity-heading"
      className="bg-crisp-white border border-oat p-6 sm:p-8 rounded-surface shadow-lift mb-8"
    >
      <h3 id="security-activity-heading" className="font-display text-lg font-semibold text-charcoal mb-2">
        Recent security activity
      </h3>
      <ul className="space-y-3">
        {items.slice(0, 5).map((n) => (
          <li key={n.id} className="text-sm font-ui text-ink">
            <span className="font-semibold">{TITLE[n.kind]}</span>
            <span className="text-taupe"> · {new Date(n.created_at).toLocaleString()}</span>
            <p className="text-xs text-taupe mt-0.5">{n.message}</p>
          </li>
        ))}
      </ul>
    </section>
  );
};
