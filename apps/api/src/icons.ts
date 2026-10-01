import {
  Controller,
  Injectable,
  Get,
  Post,
  Query,
  Req,
  Res,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Database } from './database';
import { UserRequest } from './auth';

export const iconName = z.string().trim().min(1).max(100);
export const iconHash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export async function normalizeIcon(data: Buffer) {
  if (!data.length || data.length > 2 * 1024 * 1024)
    throw new BadRequestException('图标不能超过 2 MB');
  try {
    const image = sharp(data, { limitInputPixels: 16000000, animated: false });
    const meta = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1)
      throw Error();
    return await image
      .rotate()
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    throw new BadRequestException('请选择有效的静态 PNG、JPG 或 WebP 图片');
  }
}
export async function validateStoredIcon(image: string, hash: string) {
  const data = Buffer.from(image, 'base64');
  if (data.toString('base64') !== image || iconHash(data) !== hash)
    throw new BadRequestException('图标内容或校验值无效');
  await normalizeIcon(data);
  const meta = await sharp(data).metadata();
  if (meta.format !== 'png' || !meta.width || !meta.height || meta.width > 256 || meta.height > 256)
    throw new BadRequestException('备份图标必须是规范的 PNG');
  return data;
}
@Injectable()
export class IconsService {
  constructor(private db: Database) {}
  async requireVisible(userId: string, id?: string | null) {
    if (
      id &&
      !(await this.db.icon.findFirst({
        where: { id, OR: [{ shared: true }, { ownerId: userId }] },
        select: { id: true },
      }))
    )
      throw new BadRequestException('图标不存在或无权使用');
  }
}
@Controller('api/icons')
export class IconsController {
  constructor(private db: Database) {}
  @Get() async list(@Req() r: UserRequest, @Query('q') q = '', @Query('page') page = '1') {
    const query = z.string().trim().max(100).parse(q);
    const index = z.coerce.number().int().min(1).max(100000).parse(page);
    const where = { OR: [{ shared: true }, { ownerId: r.userId }], name: { contains: query } };
    const [items, total] = await this.db.$transaction([
      this.db.icon.findMany({
        where,
        select: { id: true, name: true, shared: true, source: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (index - 1) * 60,
        take: 60,
      }),
      this.db.icon.count({ where }),
    ]);
    return { items, total, page: index };
  }
  @Get(':id/image') async image(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const icon = await this.db.icon.findFirst({
      where: { id, OR: [{ shared: true }, { ownerId: r.userId }] },
    });
    if (!icon) throw new NotFoundException('图标不存在');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(icon.data));
  }
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 3 },
    }),
  )
  async upload(
    @Req() r: UserRequest,
    @Body() raw: unknown,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const v = z
      .object({
        name: iconName,
        shared: z.enum(['true', 'false']).default('false'),
        confirmed: z.literal('true').optional(),
      })
      .strict()
      .parse(raw);
    const shared = v.shared === 'true';
    if (shared && (!/\p{Script=Han}/u.test(v.name) || v.confirmed !== 'true'))
      throw new BadRequestException('共享图标须填写中文名称并明确确认公开给所有用户');
    if (!file) throw new BadRequestException('请选择图标文件');
    const data = await normalizeIcon(file.buffer),
      hash = iconHash(data);
    const icon = await this.db.icon.upsert({
      where: { ownerId_hash_shared: { ownerId: r.userId, hash, shared } },
      create: { name: v.name, ownerId: r.userId, shared, hash, data },
      update: {},
      select: { id: true, name: true, shared: true, source: true },
    });
    return icon;
  }
}
