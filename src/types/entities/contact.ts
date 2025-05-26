/**
 * Contact entity type definitions
 */

import { IEntity } from '../base';

export interface IContact extends IEntity {
  name?: string;
  email: string;
  age?: number;
}

export interface ContactCreateData {
  name?: string;
  email: string;
  age?: number;
}

export interface ContactUpdateData {
  name?: string;
  email?: string;
  age?: number;
}

export interface ContactRow {
  id?: string;
  name?: string;
  email: string;
  age?: number;
  created_at: Date;
  updated_at: Date;
}
