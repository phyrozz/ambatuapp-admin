import Image from 'next/image';

export function StudioMark() {
  return <Image className="studio-mark" src="/app-icon.svg" alt="" width={40} height={40} priority />;
}

export function StudioBrand() {
  return <><StudioMark/><span className="studio-brand-copy"><span className="studio-wordmark">ambatu<span>app</span></span><span className="studio-badge">Studio</span></span></>;
}
