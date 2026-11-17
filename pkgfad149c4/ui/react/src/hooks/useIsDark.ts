/*
 * Tracks whether the `.dark` class is on <html>, so non-React layers (map tiles) can follow the theme toggle.
 */
import { useEffect, useState } from 'react';

export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const html = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(html.classList.contains('dark')));
    observer.observe(html, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}
