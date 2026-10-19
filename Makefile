.PHONY: all install test check dev start clean

all: check

install:
	npm install

test:
	npm run test

check:
	npm run check

dev:
	npm run dev

start:
	npm run start

clean:
	rm -rf node_modules coverage .vitest
