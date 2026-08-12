/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          '1': 'hsl(var(--chart-1))', '2': 'hsl(var(--chart-2))', '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))', '5': 'hsl(var(--chart-5))'
        },
        canvas: '#F5F6F8',
        surface: {
          1: '#FFFFFF',
          2: '#F8FAFC',
          3: '#F1F5F9',
        },
        cyan: { DEFAULT: '#2563EB', dim: '#DBEAFE', ice: '#1D4ED8' },
        amazon: { DEFAULT: '#1A8A44', light: '#DCFCE7', deep: '#0F5C2E' },
        azure: { DEFAULT: '#0066CC', light: '#E0EDFF' },
        green: { DEFAULT: '#10B981', forest: '#065F46', pale: '#D1FAE5' },
        amber: { DEFAULT: '#F59E0B', burnt: '#B45309', soft: '#FEF3C7' },
        crimson: { DEFAULT: '#EF4444', deep: '#7F1D1D', pale: '#FECACA' },
      },
      fontFamily: {
        heading: ['var(--font-heading)'],
        body: ['var(--font-body)'],
        display: ['var(--font-display)'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 4px 16px rgba(0,0,0,0.06)',
        'card-hover': '0 6px 20px rgba(0,0,0,0.08)',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
        'pulse-badge': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.7', transform: 'scale(0.97)' },
        },
        'slide-vanish': {
          '0%': { opacity: '1', transform: 'translateX(0)' },
          '100%': { opacity: '0', transform: 'translateX(40px)' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'pulse-badge': 'pulse-badge 2s ease-in-out infinite',
        'slide-vanish': 'slide-vanish 0.4s ease-out forwards',
        'fade-in': 'fade-in 0.3s ease-out',
      },
    }
  },
  plugins: [require("tailwindcss-animate")],
}
