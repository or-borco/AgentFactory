export class PromptTooLongError extends Error {
  constructor() {
    super("Prompt is too long for the assigned model's context window");
    this.name = "PromptTooLongError";
  }
}

export class InsufficientCreditError extends Error {
  constructor() {
    super("The connected model provider account has run out of usage credits");
    this.name = "InsufficientCreditError";
  }
}
