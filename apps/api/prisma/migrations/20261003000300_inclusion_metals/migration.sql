ALTER TABLE User ADD COLUMN includeIndependentAssets BOOLEAN NOT NULL DEFAULT true COMMENT '独立资产是否参与资产总览和净资产轨迹';
ALTER TABLE Position
 ADD COLUMN included BOOLEAN NOT NULL DEFAULT true COMMENT '是否参与资产负债总额及净资产轨迹',
 ADD COLUMN metalType VARCHAR(12) NULL COMMENT '贵金属品种：gold 黄金或 silver 白银',
 ADD COLUMN metalGrams DECIMAL(24,8) NULL COMMENT '贵金属总重量，单位克',
 ADD COLUMN metalPurity DECIMAL(12,8) NOT NULL DEFAULT 1 COMMENT '贵金属纯度比例，0 至 1',
 ADD COLUMN autoValuation BOOLEAN NOT NULL DEFAULT false COMMENT '是否随每日价格更新自动记录估值';
CREATE TABLE MetalPrice (
 id CHAR(36) NOT NULL COMMENT '唯一标识',
 userId CHAR(36) NOT NULL COMMENT '所属用户标识，用于数据隔离',
 metalType VARCHAR(12) NOT NULL COMMENT '品种：gold 黄金或 silver 白银',
 currency CHAR(3) NOT NULL COMMENT '价格币种',
 price DECIMAL(24,12) NOT NULL COMMENT '纯金属每克价格',
 date DATE NOT NULL COMMENT '报价日期，UTC+8 自然日',
 source VARCHAR(20) NOT NULL COMMENT '价格来源：manual 或 goldprice',
 quotedAt DATETIME(3) NOT NULL COMMENT '报价对应时间，UTC',
 PRIMARY KEY (id),
 UNIQUE INDEX MetalPrice_userId_metalType_currency_date_key (userId, metalType, currency, date),
 CONSTRAINT MetalPrice_userId_fkey FOREIGN KEY (userId) REFERENCES User(id) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '用户的贵金属每克参考价历史';
