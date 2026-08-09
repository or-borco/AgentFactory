# Dark Mode - Quick Start Guide

## What Was Added

A complete dark mode system for the AgentFactory application with automatic system preference detection, user preferences, and persistent storage.

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/lib/theme/context.tsx` | Theme provider and useTheme hook |
| `apps/web/src/lib/theme/__tests__/context.test.tsx` | 10 unit tests for theme functionality |
| `apps/web/src/app/globals.css` | Light and dark color palettes |
| `apps/web/src/app/layout.tsx` | Integration of ThemeProvider |
| `apps/web/src/components/ThemeToggle.tsx` | Example theme toggle component |

## How to Use

### Basic Usage

```tsx
"use client";

import { useTheme } from "@/lib/theme";

export function MyComponent() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div>
      <p>Current theme: {theme}</p>
      <button onClick={toggleTheme}>
        Switch to {theme === "light" ? "dark" : "light"} mode
      </button>
    </div>
  );
}
```

### Available Hook Methods

```tsx
const { 
  theme,           // "light" | "dark"
  toggleTheme,     // () => void - switches between light and dark
  setTheme         // (theme: "light" | "dark") => void - set specific theme
} = useTheme();
```

### Using Theme Colors in Styles

All Tailwind components automatically adapt to the theme via CSS custom properties:

```tsx
// Light: white background, dark text
// Dark: dark background, light text
<div className="bg-[var(--color-bg)] text-[var(--color-text)]">
  Content automatically adapts to theme
</div>
```

## How It Works

1. **On Page Load**: 
   - Checks localStorage for saved theme preference
   - Falls back to system OS preference (prefers-color-scheme)
   - Falls back to dark mode as default

2. **When Theme Changes**:
   - Saves preference to localStorage
   - Applies `dark` class to `<html>` element (dark mode)
   - Removes `dark` class from `<html>` element (light mode)
   - CSS variables automatically update via `:root` and `:root.dark`

3. **CSS Magic**:
   - All colors defined as CSS variables
   - Light mode: `:root { --color-bg: #fff; }`
   - Dark mode: `:root.dark { --color-bg: #161826; }`

## Color Variables Available

### Core Colors
- `--color-bg` - Main background
- `--color-surface` - Cards and surfaces
- `--color-text` - Text color
- `--color-accent` - Primary action color
- `--color-accent-2` - Secondary action color
- `--color-divider` - Border and divider lines

### Scales
- `--color-neutral-100` through `--color-neutral-900` - Gray scale
- `--color-accent-100` through `--color-accent-900` - Primary accent scale
- `--color-accent-2-100` through `--color-accent-2-900` - Secondary accent scale

### Status Colors
- `--color-status-blue` - Informational
- `--color-status-green` - Success
- `--color-status-amber` - Warning
- `--color-status-red` - Error
- `--color-status-teal` - Custom/Neutral

## Testing

Run the comprehensive test suite:

```bash
# Run all unit tests
npm run test:unit

# Run just theme tests
npx vitest run apps/web/src/lib/theme/__tests__/context.test.tsx
```

## Common Questions

**Q: Where is the theme stored?**  
A: In browser localStorage under the key `agentfactory-theme`

**Q: What if localStorage is not available?**  
A: The theme still works, but preference won't persist across sessions

**Q: Can I use the theme outside of client components?**  
A: No, the hook requires `"use client"` directive. For server-side rendering, use CSS variables directly

**Q: What browser versions are supported?**  
A: All modern browsers (Chrome, Firefox, Safari, Edge). System preference detection requires CSS Media Queries Level 5

**Q: How do I add a new color to the theme?**  
A: Add it to both `:root` (light) and `:root.dark` (dark) in `globals.css`, then use `var(--color-your-new-color)`

## Example: Adding a Theme Toggle to Navigation

```tsx
// In your navigation component
"use client";

import { ThemeToggle } from "@/components/ThemeToggle";

export function Navigation() {
  return (
    <nav>
      {/* ... other nav items ... */}
      <ThemeToggle />
    </nav>
  );
}
```

## Troubleshooting

**Theme not persisting between page loads?**
- Check that localStorage is enabled
- Check browser console for errors

**Theme colors not applying?**
- Ensure `ThemeProvider` wraps your component
- Verify CSS custom properties are defined in `globals.css`

**Component not showing the right colors?**
- Use CSS variables: `var(--color-bg)` not hardcoded colors
- Make sure component is inside `ThemeProvider`

## Architecture Notes

- Theme detection is **SSR-safe** - no hydration issues
- No JavaScript is required for theme to apply
- CSS variables handle all styling
- localStorage persistence is non-critical (graceful degradation)
- Works with Tailwind CSS out of the box

## Next Steps

1. **Add to Navigation** - Import `ThemeToggle` component in your header
2. **Customize Colors** - Edit values in `globals.css` for brand colors
3. **User Settings** - Create a preferences page to let users choose theme
4. **Analytics** - Track which themes users prefer (optional)

## Related Files

- Full documentation: `/DARK_MODE_IMPLEMENTATION.md`
- Test file: `/apps/web/src/lib/theme/__tests__/context.test.tsx`
- CSS colors: `/apps/web/src/app/globals.css`
