'use client';

import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { trackEvent, PlausibleEvent } from './PlausibleEvents';

type SupportLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>;

/** One support affordance with one analytics event and no user data payload. */
export function SupportLink({ onClick, ...props }: SupportLinkProps) {
  return (
    <a
      {...props}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        trackEvent(PlausibleEvent.supportContact);
        onClick?.(event);
      }}
    />
  );
}
