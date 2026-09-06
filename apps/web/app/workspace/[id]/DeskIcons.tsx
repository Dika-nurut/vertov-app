import type { SVGProps } from 'react';

type IconName =
  | 'pen'
  | 'network'
  | 'video'
  | 'sparkles'
  | 'users'
  | 'folder'
  | 'folderOpen'
  | 'plus'
  | 'upload'
  | 'image'
  | 'play'
  | 'music'
  | 'clock'
  | 'document'
  | 'boardFile'
  | 'exit'
  | 'close';

export function DeskIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const common = { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true, ...props };
  if (name === 'pen')
    return (
      <svg {...common}>
        <path d="m22 4V3h-1V2h-1V1h-3v1h-1v1h-1v1h-1v1h-2v1H9v1H6v1H5v2H4v3H3v3H2v3H1v3h1v1h3v-1h3v-1h3v-1h3v-1h2v-1h1v-3h1v-3h1v-2h1V9h1V8h1V7h1V4h-1Zm-6 8v3h-1v2h-1v1h-3v1H8v1H6v-1h1v-1h1v-1h1v-1h3v-3h-1v-1H8v3H7v1H6v1H5v1H4v-2h1v-3h1v-3h1V9h2V8h3V7h3v1h1v1h1v3h-1Z" />
      </svg>
    );
  if (name === 'document')
    return (
      <svg {...common}>
        <path d="M4 2h13l5 5v15H4V2Zm2 2v16h14V8h-6V4H6Zm2 6h10v2H8v-2Zm0 4h10v2H8v-2Zm0 4h6v2H8v-2Z" />
      </svg>
    );
  if (name === 'boardFile')
    return (
      <svg {...common}>
        <path d="M4 2h13l5 5v15H4V2Zm2 2v16h14V8h-6V4H6Zm2 7h3v2H8v-2Zm5 0h3v2h-3v-2Zm-5 4h3v2H8v-2Zm5 0h3v2h-3v-2Z" />
      </svg>
    );
  if (name === 'exit')
    return (
      <svg {...common}>
        <path d="M11 3H4v18h7v-2H6V5h5V3Zm9 9-5-5v3H9v4h6v3l5-5Z" />
      </svg>
    );
  if (name === 'network')
    return (
      <svg {...common}>
        <path d="M7 7H5V6H4V4h1V3h2v1h1v2H7v1Zm-2 4h1v3H5v1H2v-1H1v-3h1v-1h3v1Zm11 3v-3h-1v-1h-1V9h-3v1h-1v1H9v3h1v1h1v1h3v-1h1v-1h1Zm-5 0v-3h3v3h-3Zm10 4h1v3h-1v1h-3v-1h-1v-3h1v-1h3v1Zm1-13v2h-1v1h-2V7h-1V5h1V4h2v1h1Z" />
        <path d="M8 7h1v1H8zm1 1h1v1H9zm7 1h1v1h-1zm1-1h1v1h-1zm-1 7h1v1h-1zm1 1h1v1h-1zM7 12h1v1H7zm8 3h1v1h-1z" />
      </svg>
    );
  if (name === 'video')
    return (
      <svg {...common}>
        <path d="M23 7v10h-1v1h-1v-1h-1v-1h-1v-1h-1V9h1V8h1V7h1V6h1v1h1ZM15 7V5H3v1H2v1H1v10h1v1h1v1h12v-2h1V7h-1Zm-1 9h-1v1H4v-1H3V8h1V7h9v1h1v8Z" />
      </svg>
    );
  if (name === 'sparkles')
    return (
      <svg {...common}>
        <path d="M23 5v1h-2v1h-1v2h-1V7h-1V6h-2V5h2V4h1V2h1v2h1v1h2Zm0 13v1h-2v1h-1v2h-1v-2h-1v-1h-2v-1h2v-1h1v-2h1v2h1v1h2ZM15 11v-1h-2V9h-1V8h-1V6h-1V4H8v2H7v2H6v1H5v1H3v1H1v2h2v1h2v1h1v1h1v2h1v2h2v-2h1v-2h1v-1h1v-1h2v-1h2v-2h-2Zm-3 2v1h-1v1h-1v2H8v-2H7v-1H6v-1H4v-2h2v-1h1V9h1V7h2v2h1v1h1v1h2v2h-2Z" />
      </svg>
    );
  if (name === 'users')
    return (
      <svg {...common}>
        <path d="M19 18v-1h-1v-1h-2v-1H8v1H6v1H5v1H4v3h1v1h14v-1h1v-3h-1Zm-11 0v-1h8v1h2v2H6v-2h2Zm7-11V6h-1V5h-4v1H9v1H8v4h1v1h1v1h4v-1h1v-1h1V7h-1Zm-5 4V7h4v4h-4Z" />
      </svg>
    );
  if (name === 'folder' || name === 'folderOpen')
    return name === 'folder' ? (
      <svg {...common}>
        <path d="M22 6V5h-9V4h-1V3h-1V2H2v1H1v18h1v1h20v-1h1V6h-1Zm-1 14H3V4h7v1h1v1h1v1h9v13Z" />
      </svg>
    ) : (
      <svg {...common}>
        <path d="M6 10v2H5v2H4v2H3v2H2v3h1v1h15v-1h1v-3h1v-2h1v-2h1v-2h1v-2H6Zm14 4h-1v2h-1v2h-1v2H4v-2h1v-2h1v-2h1v-2h13v2Z" />
        <path d="M20 5v4h-2V6H9V5H8V4H3v10H2v2H1V3h1V2h7v1h1v1h9v1h1Z" />
      </svg>
    );
  if (name === 'plus')
    return (
      <svg {...common}>
        <path d="M23 11v2H13v10h-2V13H1v-2h10V1h2v10h10Z" />
      </svg>
    );
  if (name === 'upload')
    return (
      <svg {...common}>
        <path d="M4 10V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-2V9h-1V8h-1V7h-1V6h-1V5h-1v12h-2V5h-1v1H9v1H8v1H7v1H6v1H4Zm-2 10h20v3H2v-3Z" />
      </svg>
    );
  if (name === 'image')
    return (
      <svg {...common}>
        <path d="M22 2V1H2v1H1v20h1v1h20v-1h1V2h-1Zm-1 19H3V3h18v18ZM9 6v3H8v1H5V9H4V6h1V5h3v1h1Zm7 7h1v1h1v1h1v1h1v3H8v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v1h1Z" />
      </svg>
    );
  if (name === 'play')
    return (
      <svg {...common}>
        <path d="M21 11v-1h-1V9h-2V8h-2V7h-1V6h-2V5h-2V4h-1V3H8V2H6V1H3v1H2v20h1v1h3v-1h2v-1h2v-1h1v-1h2v-1h2v-1h1v-1h2v-1h2v-1h1v-1h1v-2h-1ZM19 13h-2v1h-2v1h-1v1h-2v1h-2v1H9v1H7v1H5v1H4V3h1v1h2v1h2v1h1v1h2v1h2v1h1v1h2v1h2v2Z" />
      </svg>
    );
  if (name === 'music')
    return (
      <svg {...common}>
        <path d="M21 1v1h-3v1h-3v1h-4v1H8v1H6v10H3v1H2v1H1v3h1v1h1v1h4v-1h1v-1h1V11h2v-1h4V9h3V8h2v5h-3v1h-1v1h-1v3h1v1h1v1h4v-1h1v-1h1V1h-2ZM3 21v-3h4v3H3Zm15-3v-3h4v3h-4Z" />
      </svg>
    );
  if (name === 'clock')
    return (
      <svg {...common}>
        <path d="M17 2V1H7v1H5v1H4v1H3v2H2v12h1v2h1v1h1v1h2v1h10v-1h2v-1h1v-1h1v-2h1V6h-1V4h-1V3h-1V2h-2Zm3 16h-1v2h-2v1H7v-1H5v-2H4V6h1V4h2V3h10v1h2v2h1v12Z" />
        <path d="M11 5h2v7h5v2h-7V5Z" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="m5 4 7 7 7-7 1 1-7 7 7 7-1 1-7-7-7 7-1-1 7-7-7-7 1-1Z" />
    </svg>
  );
}
