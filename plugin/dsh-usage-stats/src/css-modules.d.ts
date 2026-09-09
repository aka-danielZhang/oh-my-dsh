/** CSS Modules (transformed inline at build time; see tsdown.config.ts). */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}
