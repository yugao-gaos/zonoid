## Repository Knowledge Base (Zonoid)

- **[note] [ingest] Finite-field domains hardcode is_nonnegative=True, is_negative=False**: FiniteField domain methods return is_nonnegative as True and is_negative as False unconditionally (is_positive is just bool(a)). Modular integers / finite fields are not ordered fields, so ordered com
- **[note] [ingest] Never create a new expression inside an assumptions handler**: In _eval_is_* handlers, pull args apart structurally (e.g. as_independent) rather than building expressions like (x/pi).is_even. Constructing a new expression re-invokes constructors that themselves q
- **[note] [ingest] Define assumption-bearing test symbols inside each test function, not module-level**: Symbols carrying assumptions (e.g. Symbol('x', positive=True)) are best defined inside each test function rather than at module top, so an assumption doesn't accidentally leak into another test that e
- **[note] [ingest] GF(p) defaults to symmetric=True, so to_int() can return negatives**: GF/FiniteField defaults symmetric=True: K.to_int(a) maps the upper half of residues to negative integers (e.g. in GF(5), residue 3 maps to -2). int(a) always returns a nonnegative residue, and int(a)'
- **[note] [ingest] Deprecations must go through sympy_deprecation_warning(), never the warning class**: All deprecations must use sympy.utilities.exceptions.sympy_deprecation_warning (or the @deprecated decorator); using the SymPyDeprecationWarning class directly is explicitly forbidden. Both deprecated

