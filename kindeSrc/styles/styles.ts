// Baker 1031 brand variables for the Kinde auth widget
const kindeVariables = {
  baseFontFamily:
    "-apple-system, system-ui, BlinkMacSystemFont, Helvetica, Arial, Segoe UI, Roboto, sans-serif",
  buttonPrimaryBackgroundColor: "#2b3a5f",
  buttonPrimaryColor: "#ffffff",
  buttonBorderRadius: "6px",
  buttonSecondaryBackgroundColor: "#ffffff",
  buttonSecondaryBorderWidth: "1px",
  buttonSecondaryBorderColor: "#cfd4dd",
  buttonSecondaryBorderStyle: "solid",
  buttonSecondaryBorderRadius: "6px",
  controlSelectTextBorderRadius: "6px",
} as const;

export const getStyles = (): string => `
  :root {
    --kinde-base-font-family: ${kindeVariables.baseFontFamily};
    --kinde-control-select-text-border-radius: ${kindeVariables.controlSelectTextBorderRadius};
    --kinde-button-primary-background-color: ${kindeVariables.buttonPrimaryBackgroundColor};
    --kinde-button-primary-color: ${kindeVariables.buttonPrimaryColor};
    --kinde-button-border-radius: ${kindeVariables.buttonBorderRadius};
    --kinde-button-secondary-background-color: ${kindeVariables.buttonSecondaryBackgroundColor};
    --kinde-button-secondary-border-width: ${kindeVariables.buttonSecondaryBorderWidth};
    --kinde-button-secondary-border-color: ${kindeVariables.buttonSecondaryBorderColor};
    --kinde-button-secondary-border-style: ${kindeVariables.buttonSecondaryBorderStyle};
    --kinde-button-secondary-border-radius: ${kindeVariables.buttonSecondaryBorderRadius};
  }

  body { margin: 0; }
  /* Widget field + button styling to match the card design */
  [data-kinde-control-label] { font-weight: 600; color: #2f3237; }
  [data-kinde-button-variant="primary"] {
    width: 100%;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  [data-kinde-choice-separator] { text-transform: uppercase; }
  [data-kinde-layout-auth-buttons] { display: flex; justify-content: center; }
  [data-kinde-layout-auth-buttons-item] { width: 3rem; height: 3rem; }
`;
