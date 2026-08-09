# Dark Mode Implementation

## Overview

A complete dark mode implementation has been added to the AgentFactory application. The system supports:

- **Light mode** (default)
- **Dark mode** (with user preference detection)
- **System preference detection** (respects OS dark mode preference)
- **Persistent theme selection** (saved to localStorage)
- **Smooth theme switching** with React context

## Architecture

### Components

1. **Theme Context** (`/apps/web/src/lib/theme/context.tsx`)
   - React Context for managing theme state
   - Automatically detects user's system preference
   - Persists theme choice to localStorage under key `agentfactory-theme`
   - Applies `dark` CSS class to `<html>` element for dark mode

2. **CSS Custom Properties** (`/apps/web/src/app/globals.css`)
   - Light mode colors defined in `:root`
   - Dark mode colors defined in `:root.dark`
   - All color variables use CSS custom properties (variables)
   - Both semantic and functional color scales included

3. **Layout Integration** (`/apps/web/src/app/layout.tsx`)
   - `ThemeProvider` wraps the entire application
   - Placed before `I18nProvider` to ensure theme loads early
   - Works seamlessly with existing providers

## Usage

### Using the Theme Hook

In any client component:

```tsx
"use client";

import { useTheme } from "@/lib/theme";

export function ThemeToggle() {
  const { theme, toggleTheme, setTheme } = useTheme();

  return (
    <>
      <button onClick={toggleTheme}>
        Switch to {theme === "light" ? "dark" : "light"} mode
      </button>
      
      <button onClick={() => setTheme("light")}>Light</button>
      <button onClick={() => setTheme("dark")}>Dark</button>
    </>
  );
}
```

### Accessing Theme in Styles

All CSS classes and Tailwind utilities automatically respond to theme:

```tsx
// Using Tailwind with dark: variant (if configured)
<div className="bg-white dark:bg-slate-900 text-black dark:text-white">
  Content
</div>

// Or using CSS custom properties directly
<div className="bg-[var(--color-bg)] text-[var(--color-text)]">
  Content
</div>
```

## Color System

### Light Mode Colors

| Variable | Light Value | Purpose |
|----------|-------------|---------|
| `--color-bg` | `#ffffff` | Main background |
| `--color-surface` | `#f5f5f7` | Surface/cards |
| `--color-text` | `#161826` | Primary text |
| `--color-accent` | `#6366f1` | Primary accent (indigo) |
| `--color-accent-2` | `#7c3aed` | Secondary accent (purple) |

### Dark Mode Colors

| Variable | Dark Value | Purpose |
|----------|------------|---------|
| `--color-bg` | `#161826` | Main background |
| `--color-surface` | `#232532` | Surface/cards |
| `--color-text` | `#e9e9ed` | Primary text |
| `--color-accent` | `#9184d9` | Primary accent (lavender) |
| `--color-accent-2` | `#a7a1db` | Secondary accent (light purple) |

All color scales (neutral, accent, accent-2) and semantic status colors (blue, green, amber, red, teal) are defined for both themes.

## Testing

### Unit Tests

Comprehensive unit tests are provided in `/apps/web/src/lib/theme/__tests__/context.test.tsx`

Tests cover:

- ✅ Theme context provider functionality
- ✅ Default theme initialization (dark)
- ✅ System preference detection (light)
- ✅ System preference detection (dark)
- ✅ Saved theme retrieval from localStorage
- ✅ Theme toggling functionality
- ✅ Explicit theme setting
- ✅ localStorage persistence
- ✅ HTML element class management
- ✅ Error handling when hook used outside provider

### Running Tests

```bash
# Run unit tests
npm run test:unit

# Or run just the theme tests
npx vitest run apps/web/src/lib/theme/__tests__/context.test.tsx
```

## Implementation Details

### Theme Detection Priority

1. Check localStorage for saved preference (`agentfactory-theme`)
2. Check system preference via `window.matchMedia("(prefers-color-scheme: light)")`
3. Default to dark mode

### CSS Structure

The implementation uses CSS custom properties (variables) organized as:

```css
:root {
  /* Light mode defaults */
  --color-bg: #ffffff;
  --color-surface: #f5f5f7;
  /* ... more variables */
}

:root.dark {
  /* Dark mode overrides */
  --color-bg: #161826;
  --color-surface: #232532;
  /* ... more variables */
}
```

This approach ensures:
- No JavaScript dependency for styling
- Instant theme switching without flash
- Full CSS access to theme colors
- Perfect compatibility with Tailwind CSS

### HTML Class Management

When theme changes, the `dark` class is added to or removed from `<html>`:

- Dark mode: `<html class="dark">`
- Light mode: `<html>` (no class)

This allows for CSS selectors like `html.dark .element` if needed.

## Customization

### Adding New Colors

To add new theme colors:

1. Add the variable to `:root` for light mode
2. Add the variable to `:root.dark` for dark mode
3. Use via `var(--color-your-variable)` in CSS/Tailwind

Example:

```css
:root {
  --color-custom: #xyz;
}

:root.dark {
  --color-custom: #abc;
}
```

### Adjusting Color Values

Edit `/apps/web/src/app/globals.css` and modify the values in either `:root` or `:root.dark` block.

## Browser Support

- All modern browsers (Chrome, Firefox, Safari, Edge)
- Requires localStorage support (virtually all browsers)
- System preference detection requires CSS Media Queries Level 5 (`prefers-color-scheme`)

## Migration Guide

If moving existing components to use the theme system:

1. Replace hardcoded colors with CSS variables
2. Use `var(--color-*-*)` instead of color values
3. For dynamic styling based on theme, use the `useTheme()` hook

## Files Added/Modified

### New Files
- `/apps/web/src/lib/theme/context.tsx` - Theme provider and hook
- `/apps/web/src/lib/theme/index.ts` - Public exports
- `/apps/web/src/lib/theme/__tests__/context.test.tsx` - Unit tests

### Modified Files
- `/apps/web/src/app/layout.tsx` - Added ThemeProvider
- `/apps/web/src/app/globals.css` - Added light mode colors and dark mode CSS

## Future Enhancements

Potential improvements for future iterations:

1. **Theme Switch Component** - Create a reusable ThemeToggle component
2. **Smooth Transitions** - Add CSS transitions for theme switches
3. **Per-Component Customization** - Allow components to override theme colors
4. **Analytics** - Track user theme preferences
5. **Keyboard Shortcut** - Add keyboard shortcut for theme toggle
6. **Regional Preferences** - Consider regional dark mode adoption rates
7. **Schedule-Based** - Switch theme based on time of day

## Troubleshooting

### Theme not persisting
- Check browser's localStorage is enabled
- Verify no browser privacy mode is active
- Check browser console for errors

### Theme doesn't apply
- Ensure ThemeProvider wraps your component
- Check browser console for CSS/JavaScript errors
- Verify CSS custom properties are properly defined

### Flash of wrong theme on page load
- This is minimized by applying theme as early as possible
- Consider adding theme preference to page metadata if needed

## Support

For questions or issues with dark mode:
1. Check the test file for usage examples
2. Review CSS custom properties in globals.css
3. Examine the context implementation for hook usage
