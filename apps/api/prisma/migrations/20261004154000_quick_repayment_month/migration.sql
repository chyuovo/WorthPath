ALTER TABLE `Position` ADD COLUMN `lastRepaymentMonth` CHAR(7) NULL COMMENT '最后手动标记已完成还款的业务月份，UTC+8 YYYY-MM；空表示未标记';
