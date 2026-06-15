## Repository Knowledge Base (Zonoid)

- **[note] [ingest] Plot theme config subclasses mpl.RcParams and validates against rcParams**: ThemeConfig (for so.Plot.theme/config) subclasses matplotlib's RcParams so values are validated as real rcParam keys; defaults seeded to match set_theme(). PlotConfig default values are protected from
- **[note] [ingest] variable_type returns one of exactly five string tokens; compare with the full form**: Internal type inference returns only 'numeric', 'datetime', 'categorical', 'boolean', or 'unknown'. Comparisons must use the full token ('categorical', never 'category') - mismatches were a real sourc
- **[note] [ingest] Hard pins exclude specific broken upstream versions: numpy!=1.24.0, matplotlib!=3.6.1**: Dependency specifiers don't just set floors - they exclude known-bad releases: numpy>=1.20,!=1.24.0 and matplotlib>=3.4,!=3.6.1. Don't 'simplify' these to plain floors.

