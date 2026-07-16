import {
  IsArray,
  IsDate,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Role, TaskPriority, TaskType } from '@prisma/client';
import {
  BrowserSessionRestoreReason,
  SecureCredentialMode,
} from '../task-security.types';

export class TaskFileDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  base64: string;

  @IsNotEmpty()
  @IsString()
  type: string;

  @IsNotEmpty()
  @IsNumber()
  size: number;
}

export class SecureCredentialDto {
  @IsNotEmpty()
  @IsString()
  site: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  otp?: string;

  @IsNotEmpty()
  @IsString()
  mode: SecureCredentialMode;

  @IsOptional()
  @IsString()
  sessionLabel?: string;
}

export class SavedBrowserSessionDto {
  @IsNotEmpty()
  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  site?: string;

  @IsOptional()
  @IsString()
  browser?: 'brave' | 'firefox';
}

export class CreateTaskDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  task?: string;

  @IsOptional()
  @IsString()
  type?: TaskType;

  @IsOptional()
  @IsDate()
  scheduledFor?: Date;

  @IsOptional()
  @IsString()
  priority?: TaskPriority;

  @IsOptional()
  @IsString()
  createdBy?: Role;

  @IsOptional()
  model?: any;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskFileDto)
  files?: TaskFileDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SecureCredentialDto)
  secureCredential?: SecureCredentialDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SavedBrowserSessionDto)
  savedBrowserSession?: SavedBrowserSessionDto;

  @IsOptional()
  @IsString()
  savedBrowserSessionRestoreReason?: BrowserSessionRestoreReason;
}
