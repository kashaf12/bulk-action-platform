/**
 * Contact entity type definitions
 */

import { IEntity } from '../base';

export interface IContact extends IEntity {
  name?: string;
  email: string;
  age?: number;
  phone?: string;
  company?: string;
  status?: 'active' | 'inactive' | 'pending';
}

export interface ContactCreateData {
  name?: string;
  email: string;
  age?: number;
  phone?: string;
  company?: string;
  status?: 'active' | 'inactive' | 'pending';
}

export interface ContactUpdateData {
  name?: string;
  email?: string;
  age?: number;
  phone?: string;
  company?: string;
  status?: 'active' | 'inactive' | 'pending';
}

export interface ContactRow {
  id?: string;
  name?: string;
  email: string;
  age?: number;
  phone?: string;
  company?: string;
  status?: string;
  created_at: Date;
  updated_at: Date;
}
