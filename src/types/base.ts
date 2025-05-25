/**
 * Base type definitions - fundamental types used across the application
 */

export interface IEntity {
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface FieldValidator {
  (value: unknown): boolean;
}

export interface FieldValidators {
  [fieldName: string]: FieldValidator;
}

export interface ErrorDetails {
  code?: string;
  field?: string;
  value?: unknown;
}
