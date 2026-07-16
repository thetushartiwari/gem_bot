import { IsOptional, IsString } from 'class-validator';

export class AddTaskMessageDto {
  @IsOptional()
  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  content?: string;
}
