ALTER TABLE `Position` ADD COLUMN `lastBookedDate` CHAR(10) NULL COMMENT '最后手动标记已完成记账的业务日期，UTC+8 YYYY-MM-DD；空表示未标记';
