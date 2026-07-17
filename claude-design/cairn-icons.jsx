/* Minimal, consistent line iconography — 1.5 stroke, 16px viewbox */
const Icon = ({ name, size = 16, ...rest }) => {
  const props = {
    width: size, height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...rest,
  };
  switch (name) {
    case "hash":    return <svg {...props}><path d="M3 6h10M3 10h10M6 3l-1 10M11 3l-1 10"/></svg>;
    case "lock":    return <svg {...props}><rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 1 1 5 0v2"/></svg>;
    case "users":   return <svg {...props}><circle cx="6" cy="6" r="2.2"/><path d="M2.5 13c.5-2 1.8-3 3.5-3s3 1 3.5 3"/><path d="M10.5 5.5a2 2 0 1 1 0 3"/><path d="M11.5 13c-.2-1.5-1.2-2.5-2.5-2.8"/></svg>;
    case "person":  return <svg {...props}><circle cx="8" cy="5.5" r="2.4"/><path d="M3 13.5c.6-2.4 2.5-3.7 5-3.7s4.4 1.3 5 3.7"/></svg>;
    case "search":  return <svg {...props}><circle cx="7" cy="7" r="3.5"/><path d="m10 10 3 3"/></svg>;
    case "plus":    return <svg {...props}><path d="M8 3v10M3 8h10"/></svg>;
    case "back":    return <svg {...props}><path d="M10 3 5 8l5 5"/></svg>;
    case "x":       return <svg {...props}><path d="M4 4l8 8M12 4l-8 8"/></svg>;
    case "send":    return <svg {...props}><path d="M2.5 8 13 3l-3 10-2-4-5.5-1Z"/></svg>;
    case "attach":  return <svg {...props}><path d="M11 5 6 10a1.8 1.8 0 0 0 2.5 2.5l5-5a3.2 3.2 0 0 0-4.5-4.5l-5 5a4.5 4.5 0 0 0 6.3 6.3l4.7-4.7"/></svg>;
    case "smile":   return <svg {...props}><circle cx="8" cy="8" r="5.5"/><circle cx="6" cy="7" r=".5" fill="currentColor"/><circle cx="10" cy="7" r=".5" fill="currentColor"/><path d="M6 10c.6.7 1.3 1 2 1s1.4-.3 2-1"/></svg>;
    case "settings":return <svg {...props}><circle cx="8" cy="8" r="2"/><path d="M8 1.5v1.8M8 12.7v1.8M2.6 5l1.6.9M11.8 10.1l1.6.9M2.6 11l1.6-.9M11.8 5.9l1.6-.9M1.5 8h1.8M12.7 8h1.8"/></svg>;
    case "phone":   return <svg {...props}><path d="M3.5 3.5h2.6l1.2 3-1.5 1A7.4 7.4 0 0 0 8.9 11l1-1.5 3 1.2v2.6a1 1 0 0 1-1 1A10.5 10.5 0 0 1 2.5 4.5a1 1 0 0 1 1-1Z"/></svg>;
    case "info":    return <svg {...props}><circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3.5M8 5.2v.2"/></svg>;
    case "more":    return <svg {...props}><circle cx="3.5" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r=".9" fill="currentColor" stroke="none"/></svg>;
    case "check":   return <svg {...props}><path d="m3.5 8.5 3 3 6-6.5"/></svg>;
    case "check2":  return <svg {...props}><path d="m3 8.5 2.5 2.5L10 6"/><path d="m7 11 1 1L13 7"/></svg>;
    case "clock":   return <svg {...props}><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>;
    case "warning": return <svg {...props}><path d="m8 2.5 6 11H2l6-11Z"/><path d="M8 7v3"/><circle cx="8" cy="11.7" r=".5" fill="currentColor" stroke="none"/></svg>;
    case "shield":  return <svg {...props}><path d="M8 2 3 4v4c0 3 2 5 5 6 3-1 5-3 5-6V4l-5-2Z"/><path d="m5.5 8 2 2 3-3.5"/></svg>;
    case "spark":   return <svg {...props}><path d="M8 2v3M8 11v3M2 8h3M11 8h3M3.5 3.5l2 2M10.5 10.5l2 2M3.5 12.5l2-2M10.5 5.5l2-2"/></svg>;
    case "mesh":    return <svg {...props}><circle cx="4" cy="4" r="1.2"/><circle cx="12" cy="4" r="1.2"/><circle cx="4" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="8" cy="8" r="1.2"/><path d="m5 5 2 2M11 5l-2 2M5 11l2-2M11 11l-2-2" strokeOpacity=".6"/></svg>;
    case "bolt":    return <svg {...props}><path d="m9 2-5 7h3l-1 5 5-7H8l1-5Z"/></svg>;
    case "house":   return <svg {...props}><path d="M2.5 7 8 3l5.5 4v6.5h-11V7Z"/><path d="M6.5 13.5v-3.5h3v3.5"/></svg>;
    case "kebab":   return <svg {...props}><circle cx="8" cy="3.5" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="12.5" r=".9" fill="currentColor" stroke="none"/></svg>;
    case "sliders": return <svg {...props}><path d="M2.5 5h7M11.5 5h2M2.5 11h2M6.5 11h7"/><circle cx="10.5" cy="5" r="1.5"/><circle cx="5.5" cy="11" r="1.5"/></svg>;
    case "logs":    return <svg {...props}><path d="M3 3h10v10H3z"/><path d="M5 6h6M5 8h6M5 10h4"/></svg>;
    case "leaf":    return <svg {...props}><path d="M3 13c0-6 4-9 10-10-1 6-4 10-10 10Z"/><path d="M3 13 8 8"/></svg>;
    case "pin":     return <svg {...props}><path d="M9.5 2.5 12.5 5.5 11 7l-3.5 1L5 11l-2-2 3-2.5L7 3l1.5-1.5 1 1Z"/><path d="M5 11l-2.5 2.5"/></svg>;
    case "archive": return <svg {...props}><rect x="2.5" y="3.5" width="11" height="3" rx="0.6"/><path d="M3.5 6.5v6.5h9V6.5"/><path d="M6.5 9h3"/></svg>;
    case "reply":   return <svg {...props}><path d="M6 3 2 7l4 4"/><path d="M2 7h7a4 4 0 0 1 4 4v2"/></svg>;
    case "copy":    return <svg {...props}><rect x="5" y="3" width="8" height="9" rx="1.5"/><path d="M3 5.5v7A1.5 1.5 0 0 0 4.5 14H10"/></svg>;
    case "edit":    return <svg {...props}><path d="m3 13 2-1 7-7-1-1-7 7-1 2Z"/><path d="m9 4 3 3"/></svg>;
    case "trash":   return <svg {...props}><path d="M3 5h10"/><path d="M5.5 5V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V5"/><path d="m4.5 5 .8 8a1 1 0 0 0 1 .9h3.4a1 1 0 0 0 1-.9l.8-8"/><path d="M7 7.5v4M9 7.5v4"/></svg>;
    case "quote":   return <svg {...props}><path d="M4 6h2.5L5 10H3.5l.5-4Z"/><path d="M10 6h2.5L11 10H9.5l.5-4Z"/></svg>;
    case "smileplus": return <svg {...props}><path d="M13.5 4.5h2M14.5 3.5v2"/><circle cx="7.5" cy="8.5" r="5"/><circle cx="5.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/><circle cx="9.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/><path d="M5.5 10.5c.6.7 1.3 1 2 1s1.4-.3 2-1"/></svg>;
    case "camera":  return <svg {...props}><path d="M2 5.5h2.2l1-1.5h3.6l1 1.5H14a0 0 0 0 1 0 0v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5Z"/><circle cx="8" cy="8.7" r="2.3"/></svg>;
    case "eye":     return <svg {...props}><path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.9"/></svg>;
    case "expand":  return <svg {...props}><path d="M9.5 2.5h4v4M13.5 2.5l-4.5 4.5M6.5 13.5h-4v-4M2.5 13.5l4.5-4.5"/></svg>;
    case "shrink":  return <svg {...props}><path d="M13 3l-4 4M9 3.5V7h3.5M3 13l4-4M7 12.5V9H3.5"/></svg>;
    case "play":    return <svg {...props}><path d="M5 3.5l7.5 4.5L5 12.5v-9Z"/></svg>;
    case "pause":   return <svg {...props}><path d="M5.5 3.5v9M10.5 3.5v9"/></svg>;
    case "mic":     return <svg {...props}><rect x="6.5" y="2.5" width="3" height="7" rx="1.5"/><path d="M4 8a4 4 0 0 0 8 0"/><path d="M8 12v2"/></svg>;
    case "micoff":  return <svg {...props}><rect x="6.5" y="2.5" width="3" height="7" rx="1.5"/><path d="M4 8a4 4 0 0 0 8 0"/><path d="M8 12v2"/><path d="M2.5 2.5l11 11"/></svg>;
    case "snapshot":return <svg {...props}><circle cx="8" cy="8" r="4.6"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/></svg>;
    case "film":    return <svg {...props}><rect x="2.5" y="3" width="11" height="10" rx="1.2"/><path d="M5.5 3v10M10.5 3v10M2.5 6.3h3M2.5 9.7h3M10.5 6.3h3M10.5 9.7h3"/></svg>;
    case "sync":    return <svg {...props}><path d="M12.5 7a4.5 4.5 0 0 0-8-2.2M3.5 9a4.5 4.5 0 0 0 8 2.2"/><path d="M11.5 2.2V5h-2.7M4.5 13.8V11h2.7"/></svg>;
    case "qr":      return <svg {...props}><rect x="2.5" y="2.5" width="4" height="4" rx="0.6"/><rect x="9.5" y="2.5" width="4" height="4" rx="0.6"/><rect x="2.5" y="9.5" width="4" height="4" rx="0.6"/><path d="M9.5 9.5h1.5v1.5M13.5 9.5v4M9.5 13.5h1.5"/></svg>;
    case "key":     return <svg {...props}><circle cx="5" cy="5" r="2.6"/><path d="m6.9 6.9 5.1 5.1M10.5 9.5l1.5 1.5M12.5 7.5l1 1"/></svg>;
    case "bell":    return <svg {...props}><path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3L4 11Z"/><path d="M6.5 13.5a1.6 1.6 0 0 0 3 0"/></svg>;
    case "radio":   return <svg {...props}><circle cx="8" cy="8" r="1.4"/><path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.4 3.4a6.5 6.5 0 0 0 0 9.2M12.6 3.4a6.5 6.5 0 0 1 0 9.2"/></svg>;
    case "monitor": return <svg {...props}><rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.5h4M8 11v2.5"/></svg>;
    case "link":    return <svg {...props}><path d="M6.5 9.5 9.5 6.5M7 4.5 8.2 3.3a2.4 2.4 0 0 1 3.4 3.4L10.4 7.9M9 11.5 7.8 12.7a2.4 2.4 0 0 1-3.4-3.4L5.6 8.1"/></svg>;
    case "file":    return <svg {...props}><path d="M4 2.5h4.5L12 6v7.5H4V2.5Z"/><path d="M8.5 2.5V6H12"/><path d="M6 9h4M6 11h3"/></svg>;
    case "image":   return <svg {...props}><rect x="2.5" y="3" width="11" height="10" rx="1.2"/><circle cx="5.8" cy="6.2" r="1.1"/><path d="m3 11.5 3-2.5 2.5 2 2-1.5 3 2.5"/></svg>;
    case "video":   return <svg {...props}><rect x="2" y="4" width="8.5" height="8" rx="1.2"/><path d="m10.5 7 3.5-2v6l-3.5-2V7Z"/></svg>;
    case "device":  return <svg {...props}><rect x="4" y="2.5" width="8" height="11" rx="1.4"/><path d="M6.8 11.5h2.4"/></svg>;
    case "print":   return <svg {...props}><path d="M4.5 6V2.5h7V6"/><rect x="2.5" y="6" width="11" height="5" rx="1"/><path d="M4.5 9.5h7v4h-7z"/></svg>;
    case "thread":  return <svg {...props}><path d="M2.5 4.5h11M2.5 8h7M2.5 11.5h5"/><circle cx="12" cy="11" r="2"/></svg>;
    case "history": return <svg {...props}><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8"/><path d="M2.4 3.2v2.4h2.4"/><path d="M8 5.4V8l1.8 1.1"/></svg>;
    case "wifi":    return <svg {...props}><path d="M2.5 6.2a8 8 0 0 1 11 0M4.6 8.4a5 5 0 0 1 6.8 0M6.7 10.6a2 2 0 0 1 2.6 0"/><circle cx="8" cy="12.4" r=".6" fill="currentColor" stroke="none"/></svg>;
    default: return null;
  }
};

window.Icon = Icon;
