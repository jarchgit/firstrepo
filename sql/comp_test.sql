-- test_violations.sql
CREATE TABLE myTable (
  id NUMBER,
  customerName VARCHAR2(100),
  CONSTRAINT pk_test PRIMARY KEY (id)
);

CREATE INDEX idx_test ON myTable (customerName);