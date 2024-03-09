import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, FindOptionsSelect, MoreThanOrEqual, Brackets } from "typeorm";
import { Pagination } from "nestjs-typeorm-paginate";
import { IPaginationOptions } from "../common/types";
import { paginate } from "../common/utils";
import { Token, ETH_TOKEN } from "./token.entity";
import { BigNumber } from "ethers";
import { LRUCache } from "lru-cache";

// const options: LRU. = { max: 500 };
const options = {
  // how long to live in ms
  ttl: 1000 * 5,
  // return stale items before removing from cache?
  allowStale: false,
  ttlAutopurge: true,
};

const cache = new LRUCache(options);

export interface FilterTokensOptions {
  minLiquidity?: number;
  networkKey?: string;
}

const TVL_TOKEN: TokenTvl = {
  l2Address: "0x1TVLTVLTVLTVLTVLTVLTVLTVLTVLTVLTVLTVLTVL",
  l1Address: "0x0TVLTVLTVLTVLTVLTVLTVLTVLTVLTVLTVLTVLTVL",
  symbol: "__TVL__",
  name: "__TVL__",
  decimals: 18,
  iconURL: "",
  liquidity: 0,
  usdPrice: 0,
  tvl: "0",
} as TokenTvl;

export interface TokenTvl extends Token {
  tvl: string;
}

@Injectable()
export class TokenService {
  constructor(
    @InjectRepository(Token)
    private readonly tokenRepository: Repository<Token>
  ) {}

  public async findOne(address: string, fields?: FindOptionsSelect<Token>): Promise<Token> {
    const token = await this.tokenRepository.findOne({
      where: {
        l2Address: address,
      },
      select: fields,
    });
    if (!token && address.toLowerCase() === ETH_TOKEN.l2Address.toLowerCase()) {
      return ETH_TOKEN;
    }
    return token;
  }

  public async exists(address: string): Promise<boolean> {
    const tokenExists =
      (await this.tokenRepository.findOne({ where: { l2Address: address }, select: { l2Address: true } })) != null;
    if (!tokenExists && address === ETH_TOKEN.l2Address.toLowerCase()) {
      return true;
    }
    return tokenExists;
  }

  public async findAll(
    { minLiquidity, networkKey }: FilterTokensOptions,
    paginationOptions: IPaginationOptions
  ): Promise<Pagination<Token>> {
    const queryBuilder = this.tokenRepository.createQueryBuilder("token");
    if (networkKey) {
      queryBuilder.where(
        new Brackets((qb) =>
          qb.where("token.networkKey IS NULL").orWhere("token.networkKey = :networkKey", { networkKey: networkKey })
        )
      );
    }
    if (minLiquidity >= 0) {
      queryBuilder.andWhere({
        liquidity: MoreThanOrEqual(minLiquidity),
      });
    }
    queryBuilder.orderBy("token.liquidity", "DESC", "NULLS LAST");
    queryBuilder.addOrderBy("token.blockNumber", "DESC");
    queryBuilder.addOrderBy("token.logIndex", "DESC");
    return await paginate<Token>(queryBuilder, paginationOptions);
  }

  private async findAllTokens(): Promise<Token[]> {
    return this.tokenRepository.find();
  }

  public async calculateTvl(onlyTotal = true): Promise<TokenTvl[]> {
    const tvl = cache.get("tvl");
    if (tvl) {
      if (onlyTotal) {
        return [tvl[(tvl as TokenTvl[]).length - 1]];
      }
      return tvl as TokenTvl[];
    }
    console.log("Calculating TVL");
    const tokens = await this.tokenRepository.find();
    let totalTvl = BigNumber.from(0);
    const ntvl = tokens.map((token) => {
      const tvl = token.totalSupply
        .mul(Math.floor((token.usdPrice ?? 0) * 10 ** 6))
        .div(10 ** 6)
        .div(BigNumber.from(10).pow(token.decimals));
      totalTvl = totalTvl.add(tvl);
      return {
        ...token,
        tvl: tvl.toString(),
      };
    });
    TVL_TOKEN.tvl = totalTvl.toString();
    ntvl.push(TVL_TOKEN);
    cache.set("tvl", ntvl);
    if (onlyTotal) {
      return [TVL_TOKEN];
    }
    return ntvl;
  }
}
